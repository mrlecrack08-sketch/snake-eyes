// Game and money logic, run through the real Firestore REST client against the fake world
// (fake Google, Firestore with real transaction rules and index rules, and Fapshi).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, env } from './helpers/world.js';
import { cfg, configure } from '../src/config.js';
import { db, setDb } from '../src/fb.js';
import { Firestore } from '../src/firestore.js';
import { accessTokenSource, parseServiceAccount } from '../src/google.js';
import * as E from '../src/engine.js';
import * as auth from '../src/auth.js';
import * as rooms from '../src/rooms.js';
import * as payments from '../src/payments.js';
import { readUsers, credit, flush } from '../src/wallet.js';
import { uidFromPhone } from '../src/users.js';

const world = createWorld();
world.install();
const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
setDb(new Firestore({ projectId: sa.project_id, getToken: accessTokenSource(sa) }));

const NOW = 1_700_000_000_000;
const PIN = '482913';
const phoneOf = (n) => `+23767000000${n}`;
const U = { A: uidFromPhone(phoneOf(1)), B: uidFromPhone(phoneOf(2)), C: uidFromPhone(phoneOf(3)), D: uidFromPhone(phoneOf(4)) };
const bal = (u) => world.raw(`users/${u}`).balance;
const ledger = (u) => [...world.store].filter(([p]) => p.startsWith(`users/${u}/transactions/`)).map(([, d]) => d);
const ledgerSum = (u) => ledger(u).reduce((a, t) => a + t.amount, 0);

async function mkUser(uid, n, name, balance = 1000, extra = {}) {
  const r = await auth.register({ phone: phoneOf(n), pin: PIN, displayName: name, adult: true, ...extra }, NOW);
  assert.equal(r.uid, uid);
  if (balance) {
    await db.runTransaction(async (tx) => {
      const m = await readUsers(tx, [uid]);
      credit(tx, m[uid], balance, 'deposit', 'seed', NOW);
      flush(tx, m, NOW);
    });
  }
}
const reset = async () => { world.reset(); configure(env); };
const rejects = (p, code, re) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); if (re) assert.match(e.message, re); return true; });
const fapshiCalls = (path) => world.fapshi.calls.filter((c) => c.pathname === path);

// ======================================================================= accounts
test('register: validation, one account per number, referral codes, PIN stored only as a hash', async () => {
  await reset();
  await rejects(auth.register({ phone: '+33612345678', pin: PIN, displayName: 'Ann', adult: true }), 'invalid-argument');
  await rejects(auth.register({ phone: phoneOf(1), pin: PIN, displayName: 'A', adult: true }), 'invalid-argument');
  await rejects(auth.register({ phone: phoneOf(1), pin: PIN, displayName: '<script>', adult: true }), 'invalid-argument');
  await rejects(auth.register({ phone: phoneOf(1), pin: PIN, displayName: 'Ann', adult: false }), 'failed-precondition');
  await rejects(auth.register({ phone: phoneOf(1), pin: '12', displayName: 'Ann', adult: true }), 'invalid-argument', /6 digits/);
  await rejects(auth.register({ phone: phoneOf(1), pin: '123456', displayName: 'Ann', adult: true }), 'invalid-argument', /too easy/);
  await rejects(auth.register({ phone: phoneOf(1), pin: '111111', displayName: 'Ann', adult: true }), 'invalid-argument');
  await rejects(auth.register({ phone: phoneOf(1), pin: PIN, displayName: 'Ann', adult: true, referralCode: 'NOPE99' }), 'not-found');
  assert.equal(world.raw(`users/${U.A}`), undefined, 'a failed sign-up must leave nothing behind');

  assert.deepEqual(await auth.register({ phone: '6 70 00 00 01', pin: PIN, displayName: '  Ann   Lee ', adult: true }, NOW), { uid: U.A, phone: phoneOf(1) });
  const a = world.raw(`users/${U.A}`);
  assert.equal(a.displayName, 'Ann Lee');
  assert.equal(a.balance, 0);
  assert.equal(a.phone, phoneOf(1));
  assert.match(a.referralCode, /^[A-Z2-9]{6}$/);
  assert.deepEqual(world.raw(`referralCodes/${a.referralCode}`), { uid: U.A });
  const secret = world.raw(`userSecrets/${U.A}`);
  assert.ok(secret.hash && secret.salt);
  assert.ok(!JSON.stringify(secret).includes(PIN) && !JSON.stringify(world.raw(`users/${U.A}`)).includes('hash'));

  await rejects(auth.register({ phone: phoneOf(1), pin: '739104', displayName: 'Other', adult: true }), 'already-exists');
  await auth.login({ phone: phoneOf(1), pin: PIN }, NOW); // the original PIN still works

  await auth.register({ phone: phoneOf(2), pin: PIN, displayName: 'Bob', adult: true, referralCode: a.referralCode.toLowerCase() }, NOW);
  assert.equal(world.raw(`users/${U.B}`).referredBy, U.A);
});

test('login: wrong PINs count, lock the account, and a right PIN afterwards resets the count', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 0);
  await rejects(auth.login({ phone: phoneOf(9), pin: PIN }, NOW), 'permission-denied', /Wrong number or PIN/);
  await rejects(auth.login({ phone: 'abc', pin: PIN }, NOW), 'invalid-argument');
  await rejects(auth.login({ phone: phoneOf(1), pin: 'abcdef' }, NOW), 'invalid-argument');

  await rejects(auth.login({ phone: phoneOf(1), pin: '000111' }, NOW), 'permission-denied', /4 tries left/);
  await rejects(auth.login({ phone: phoneOf(1), pin: '000111' }, NOW), 'permission-denied', /3 tries left/);
  assert.deepEqual(await auth.login({ phone: phoneOf(1), pin: PIN }, NOW), { uid: U.A, phone: phoneOf(1) });
  assert.equal(world.raw(`userSecrets/${U.A}`).failed, 0);

  for (let i = 0; i < 4; i++) await rejects(auth.login({ phone: phoneOf(1), pin: '000111' }, NOW), 'permission-denied');
  await rejects(auth.login({ phone: phoneOf(1), pin: '000111' }, NOW), 'resource-exhausted', /15 minute/);
  await rejects(auth.login({ phone: phoneOf(1), pin: PIN }, NOW + 60000), 'resource-exhausted', /Try again in 14/); // even the right PIN
  assert.equal((await auth.login({ phone: phoneOf(1), pin: PIN }, NOW + 16 * 60000)).uid, U.A);
});

test('login: parallel guesses cannot dodge the counter', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 0);
  const tries = await Promise.allSettled(Array.from({ length: 12 }, () => auth.login({ phone: phoneOf(1), pin: '000111' }, NOW)));
  const locked = tries.filter((t) => t.status === 'rejected' && t.reason.code === 'resource-exhausted').length;
  const wrong = tries.filter((t) => t.status === 'rejected' && t.reason.code === 'permission-denied').length;
  assert.ok(wrong <= cfg.PIN_MAX_FAILURES, `${wrong} wrong guesses were allowed`);
  assert.ok(locked >= 1, 'the account must end up locked');
  await rejects(auth.login({ phone: phoneOf(1), pin: PIN }, NOW + 1000), 'resource-exhausted');
});

test('change PIN and admin reset', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 0);
  await rejects(auth.changePin(U.A, { pin: '000111', newPin: '739104' }, NOW), 'permission-denied');
  await rejects(auth.changePin(U.A, { pin: PIN, newPin: '123456' }, NOW), 'invalid-argument');
  await auth.changePin(U.A, { pin: PIN, newPin: '739104' }, NOW);
  await rejects(auth.login({ phone: phoneOf(1), pin: PIN }, NOW), 'permission-denied');
  await auth.login({ phone: phoneOf(1), pin: '739104' }, NOW);

  // locked out and forgot: the admin sets a temporary PIN, which also clears the lock
  for (let i = 0; i < 5; i++) await auth.login({ phone: phoneOf(1), pin: '000111' }, NOW).catch(() => {});
  await rejects(auth.login({ phone: phoneOf(1), pin: '739104' }, NOW), 'resource-exhausted');
  await rejects(auth.adminResetPin({ phone: phoneOf(7), newPin: '582016' }, NOW), 'not-found');
  assert.equal((await auth.adminResetPin({ phone: phoneOf(1), newPin: '582016' }, NOW)).name, 'Ann');
  await auth.login({ phone: phoneOf(1), pin: '582016' }, NOW);
});

// ======================================================================= rooms
test('pvp: create, join by code, play to the end, wallets balance to the franc', async () => {
  for (const rake of [0, 10]) {
    for (let game = 0; game < 60; game++) {
      await reset();
      cfg.RAKE_PERCENT = rake;
      await mkUser(U.A, 1, 'Ann', 1000);
      await mkUser(U.B, 2, 'Bob', 1000);

      const { roomId, code } = await rooms.createRoom(U.A, { mode: 'pvp', visibility: 'public' }, NOW);
      assert.equal(bal(U.A), 900);
      assert.equal(world.raw(`roomCodes/${code}`).roomId, roomId);
      assert.equal(world.raw(`users/${U.A}`).activeRoomId, roomId);

      await rooms.joinRoom(U.B, { code: code.toLowerCase() }, NOW);
      assert.equal(bal(U.B), 900);
      let room = world.raw(`rooms/${roomId}`);
      assert.equal(room.status, 'playing');

      let t = NOW;
      for (let step = 0; room.status === 'playing'; step++) {
        assert.ok(step < 3000);
        t += 1000;
        if (room.phase === 'stake') {
          const stake = room.allowed[Math.floor(Math.random() * room.allowed.length)];
          await rooms.startRound(U.A, { roomId, stake }, t);
        } else {
          await rooms.rollDice(room.cur.queue[0], { roomId }, t);
        }
        room = world.raw(`rooms/${roomId}`);
      }

      assert.equal(room.status, 'finished');
      assert.equal(room.settled, true);
      const rk = room.result.rake;
      assert.equal(bal(U.A) + bal(U.B) + rk, 2000, 'money created or lost');
      for (const u of [U.A, U.B]) {
        assert.equal(world.raw(`users/${u}`).activeRoomId, null);
        assert.equal(ledgerSum(u), bal(u), 'ledger does not match balance');
      }
      assert.equal(world.raw(`roomCodes/${code}`), undefined);
      const w = room.result.winnerUid;
      assert.ok(bal(w) >= 900 + 100 - (rake ? 10 : 0));
      assert.equal(world.raw(`users/${w}`).stats.won, 1);
      assert.equal(world.raw(`users/${w}`).stats.played, 1);
    }
  }
});

test('create/join guards', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 150);
  await mkUser(U.B, 2, 'Bob', 50);
  await mkUser(U.C, 3, 'Cy', 1000);
  const { roomId, code } = await rooms.createRoom(U.A, { mode: 'pvp', visibility: 'private' }, NOW);
  assert.equal(bal(U.A), 50);

  await rejects(rooms.createRoom(U.A, { mode: 'pvp' }, NOW), 'failed-precondition', /Finish your current room/);
  await rejects(rooms.createRoom(U.A, { mode: 'ai' }, NOW), 'failed-precondition');
  await rejects(rooms.joinRoom(U.A, { code }, NOW), 'failed-precondition', /own room/);
  await rejects(rooms.joinRoom(U.B, { code }, NOW), 'failed-precondition', /need 100/);
  await rejects(rooms.joinRoom(U.C, { code: 'ZZZZZ' }, NOW), 'not-found');
  await rejects(rooms.joinRoom(U.C, { code: '' }, NOW), 'invalid-argument');
  await rooms.joinRoom(U.C, { code }, NOW);
  await rejects(rooms.joinRoom(U.B, { roomId }, NOW), 'failed-precondition', /no longer open/);
  assert.equal(bal(U.C), 900);

  // strangers cannot act in the room; wrong turn and wrong person are refused
  await mkUser(U.D, 4, 'Dee', 0);
  await rejects(rooms.startRound(U.D, { roomId, stake: 10 }, NOW), 'permission-denied');
  await rejects(rooms.startRound(U.C, { roomId, stake: 10 }, NOW), 'permission-denied', /host/);
  await rejects(rooms.startRound(U.A, { roomId, stake: 7 }, NOW), 'invalid-argument');
  await rejects(rooms.rollDice(U.A, { roomId }, NOW), 'failed-precondition');
  await rooms.startRound(U.A, { roomId, stake: 10 }, NOW);
  await rejects(rooms.startRound(U.A, { roomId, stake: 10 }, NOW), 'failed-precondition');
  await rejects(rooms.rollDice(U.C, { roomId }, NOW), 'failed-precondition', /not your turn/);
  await rejects(rooms.rollDice(U.D, { roomId }, NOW), 'permission-denied');
});

test('cancelling a waiting room refunds the host and frees the code', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 500);
  await mkUser(U.B, 2, 'Bob', 500);
  const { roomId, code } = await rooms.createRoom(U.A, { mode: 'pvp', visibility: 'public' }, NOW);
  await rejects(rooms.cancelRoom(U.B, { roomId }, NOW), 'permission-denied');
  await rooms.cancelRoom(U.A, { roomId }, NOW);
  assert.equal(bal(U.A), 500);
  assert.equal(world.raw(`users/${U.A}`).activeRoomId, null);
  assert.equal(world.raw(`roomCodes/${code}`), undefined);
  assert.equal(ledgerSum(U.A), 500);
  await rejects(rooms.joinRoom(U.B, { code }, NOW), 'not-found');
  await rejects(rooms.cancelRoom(U.A, { roomId }, NOW), 'failed-precondition');
});

test('forfeit: leaving mid-game gives your stack to the other; leaving before round 1 refunds both', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 1000);
  await mkUser(U.B, 2, 'Bob', 1000);

  let { roomId, code } = await rooms.createRoom(U.A, { mode: 'pvp' }, NOW);
  await rooms.joinRoom(U.B, { code }, NOW);
  assert.equal((await rooms.forfeitRoom(U.B, { roomId }, NOW)).result, 'cancelled');
  assert.equal(bal(U.A), 1000);
  assert.equal(bal(U.B), 1000);

  ({ roomId, code } = await rooms.createRoom(U.A, { mode: 'pvp' }, NOW));
  await rooms.joinRoom(U.B, { code }, NOW);
  await rooms.startRound(U.A, { roomId, stake: 50 }, NOW);
  // A rolls 6+6, B rolls 2+4 -> A 150, B 50
  await rooms.rollDice(U.A, { roomId }, NOW, () => 6);
  let seq = [2, 4];
  await rooms.rollDice(U.B, { roomId }, NOW, () => seq.shift());
  assert.equal(world.raw(`rooms/${roomId}`).players[U.A].stack, 150);
  await rooms.forfeitRoom(U.A, { roomId }, NOW); // A gives up with 150 on the table
  assert.equal(bal(U.A), 900);
  assert.equal(bal(U.B), 900 + 200);
  assert.equal(world.raw(`rooms/${roomId}`).result.winnerUid, U.B);
  await rejects(rooms.forfeitRoom(U.A, { roomId }, NOW), 'failed-precondition');
});

test('snake eyes and a rolled 3 settle money correctly end to end', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 1000);
  await mkUser(U.B, 2, 'Bob', 1000);
  const { roomId, code } = await rooms.createRoom(U.A, { mode: 'pvp' }, NOW);
  await rooms.joinRoom(U.B, { code }, NOW);

  await rooms.startRound(U.A, { roomId, stake: 20 }, NOW);
  await rooms.rollDice(U.A, { roomId }, NOW, () => 1); // two ones: A wins at once, B never rolls
  let r = world.raw(`rooms/${roomId}`);
  assert.equal(r.last.reason, 'snake');
  assert.equal(r.players[U.A].stack, 120);
  assert.equal(r.players[U.B].stack, 80);
  assert.equal(r.cur.rolls.B, undefined);

  await rooms.startRound(U.A, { roomId, stake: 20 }, NOW); // round 2: B rolls first
  const s = [1, 2];
  await rooms.rollDice(U.B, { roomId }, NOW, () => s.shift()); // B rolls 3 -> eliminated
  r = world.raw(`rooms/${roomId}`);
  assert.equal(r.last.reason, 'three');
  assert.equal(r.last.winner, U.A);
  assert.equal(r.players[U.A].stack, 140);
  assert.equal(r.history.length, 2);
});

test('ties keep the same stake and only tied players re-roll', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 1000);
  await mkUser(U.B, 2, 'Bob', 1000);
  const { roomId, code } = await rooms.createRoom(U.A, { mode: 'pvp' }, NOW);
  await rooms.joinRoom(U.B, { code }, NOW);
  await rooms.startRound(U.A, { roomId, stake: 50 }, NOW);
  await rooms.rollDice(U.A, { roomId }, NOW, () => 4); // 8
  await rooms.rollDice(U.B, { roomId }, NOW, () => 4); // 8 -> tie
  let r = world.raw(`rooms/${roomId}`);
  assert.equal(r.phase, 'rolling');
  assert.equal(r.cur.ties, 1);
  assert.deepEqual(r.cur.queue, [U.A, U.B]);
  assert.equal(r.cur.lastTie.sum, 8);
  await rooms.rollDice(U.A, { roomId }, NOW, () => 2); // 4
  await rooms.rollDice(U.B, { roomId }, NOW, () => 5); // 10
  r = world.raw(`rooms/${roomId}`);
  assert.equal(r.last.winner, U.B);
  assert.equal(r.last.stake, 50);
  assert.equal(r.last.ties, 1);
});

test('practice vs COM never touches the wallet and frees the player when left', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 0);
  const { roomId, code } = await rooms.createRoom(U.A, { mode: 'ai' }, NOW);
  assert.equal(code, null);
  assert.equal(bal(U.A), 0);
  let room = world.raw(`rooms/${roomId}`);
  assert.equal(room.status, 'playing');
  for (let i = 0; i < 400 && room.status === 'playing'; i++) {
    if (room.phase === 'stake') await rooms.startRound(U.A, { roomId, stake: room.allowed[0] }, NOW + i);
    else await rooms.rollDice(U.A, { roomId }, NOW + i);
    room = world.raw(`rooms/${roomId}`);
    assert.equal(bal(U.A), 0);
    if (room.phase === 'rolling') assert.equal(room.cur.queue[0], U.A, 'COM must never be left waiting');
  }
  if (room.status === 'playing') await rooms.forfeitRoom(U.A, { roomId }, NOW);
  assert.equal(bal(U.A), 0);
  assert.equal(ledger(U.A).length, 0);
  assert.equal(world.raw(`users/${U.A}`).activeRoomId, null);
  assert.equal(world.raw(`users/${U.A}`).stats.played, 0);
});

test('sweeper: abandoned waiting room refunded, idle roller forfeits, active rooms left alone', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 1000);
  await mkUser(U.B, 2, 'Bob', 1000);
  await mkUser(U.C, 3, 'Cy', 1000);

  // waiting room nobody joined
  const w = await rooms.createRoom(U.C, { mode: 'pvp' }, NOW);
  // live room where B must roll
  const g = await rooms.createRoom(U.A, { mode: 'pvp' }, NOW);
  await rooms.joinRoom(U.B, { code: g.code }, NOW);
  await rooms.startRound(U.A, { roomId: g.roomId, stake: 10 }, NOW);
  await rooms.rollDice(U.A, { roomId: g.roomId }, NOW, () => 5);

  let out = await rooms.sweepRooms(NOW + 60 * 1000);
  assert.deepEqual([out.cancelled, out.timedOut], [0, 0]);

  out = await rooms.sweepRooms(NOW + (cfg.IDLE_TURN_SECONDS + 5) * 1000);
  assert.equal(out.timedOut, 1);
  assert.equal(world.raw(`rooms/${g.roomId}`).result.reason, 'timeout');
  assert.equal(world.raw(`rooms/${g.roomId}`).result.winnerUid, U.A);
  assert.equal(bal(U.A), 900 + 200);
  assert.equal(bal(U.B), 900);
  assert.equal(world.raw(`rooms/${w.roomId}`).status, 'waiting');

  out = await rooms.sweepRooms(NOW + (cfg.WAITING_ROOM_SECONDS + 5) * 1000);
  assert.equal(out.cancelled, 1);
  assert.equal(bal(U.C), 1000);
  assert.equal(world.raw(`users/${U.C}`).activeRoomId, null);
  assert.equal(bal(U.A) + bal(U.B) + bal(U.C), 3000);
});

// ======================================================================= deposits
const status = (id) => world.raw(`payments/${id}`).status;
const hook = (headers = { 'x-wh-secret': 'hook-secret' }) => new Headers(headers);

test('deposit: Fapshi receives the documented request; credited once even when webhook, polling and cron race', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 0);

  await rejects(payments.startDeposit(U.A, { amount: 50 }), 'invalid-argument');
  await rejects(payments.startDeposit(U.A, { amount: 500.5 }), 'invalid-argument');
  await rejects(payments.startDeposit(U.A, { amount: 1000, phone: '123' }), 'invalid-argument');
  await rejects(payments.startDeposit(U.A, { amount: 1000, phone: '640000001', provider: 'visa' }), 'invalid-argument', /MTN MoMo or Orange/);
  assert.equal(fapshiCalls('/direct-pay').length, 0);

  const d = await payments.startDeposit(U.A, { provider: 'mtn', amount: 1000, phone: '6 70 00 00 01' }, NOW);
  assert.equal(d.status, 'pending');
  assert.equal(d.payUrl, null);
  const [call] = fapshiCalls('/direct-pay');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.apiuser, 'collect-user');
  assert.equal(call.headers.apikey, 'collect-key');
  assert.deepEqual(call.body, { amount: 1000, phone: '670000001', userId: U.A, externalId: d.paymentId, message: 'Snake Eyes deposit', medium: 'mobile money', name: 'Ann' });
  const pay = world.raw(`payments/${d.paymentId}`);
  assert.equal(pay.providerRef, world.fapshi.find(d.paymentId).transId);
  assert.equal(bal(U.A), 0);

  assert.equal(await payments.refreshPayment(d.paymentId, NOW + 1000), 'pending');
  assert.equal(bal(U.A), 0);

  world.fapshi.settle(pay.providerRef, 'SUCCESSFUL');
  await Promise.all([
    payments.refreshPayment(d.paymentId), payments.refreshPayment(d.paymentId),
    payments.handleFapshiWebhook(hook(), { transId: pay.providerRef, externalId: d.paymentId, status: 'SUCCESSFUL' }),
    payments.checkPayment(U.A, { paymentId: d.paymentId }),
    payments.reconcilePayments(NOW + 10 * 60 * 1000),
  ]);
  await payments.reconcilePayments(NOW + 10 * 60 * 1000);
  assert.equal(bal(U.A), 1000);
  assert.equal(ledger(U.A).filter((t) => t.type === 'deposit').length, 1);
  assert.equal(status(d.paymentId), 'success');
  assert.deepEqual(world.raw(`users/${U.A}`).knownPhones, [phoneOf(1)]);
  assert.equal(ledgerSum(U.A), bal(U.A));
});

test('deposit: the operator is picked from the number, and can be overridden', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 0);
  await payments.startDeposit(U.A, { amount: 500, phone: '690000001' }, NOW);
  await payments.startDeposit(U.A, { amount: 500, phone: '690000002', provider: 'mtn' }, NOW);
  const bodies = fapshiCalls('/direct-pay').map((c) => c.body.medium);
  assert.deepEqual(bodies, ['orange money', 'mobile money']);
});

test('deposit: link mode sends the player to the Fapshi page and comes back to /?pay=ID', async () => {
  await reset();
  const T = Date.now();
  cfg.FAPSHI.DEPOSIT_MODE = 'link';
  await mkUser(U.A, 1, 'Ann', 0);
  const d = await payments.startDeposit(U.A, { provider: 'orange', amount: 2000 }, T);
  assert.match(d.payUrl, /^https:\/\/checkout\.fapshi\.test\/L\d+$/);
  const [c] = fapshiCalls('/initiate-pay');
  assert.deepEqual(c.body, { amount: 2000, userId: U.A, externalId: d.paymentId, message: 'Snake Eyes deposit', redirectUrl: `https://game.example/?pay=${d.paymentId}` });
  assert.equal(fapshiCalls('/direct-pay').length, 0);
  const t = world.fapshi.find(d.paymentId);
  assert.equal(await payments.refreshPayment(d.paymentId), 'pending'); // CREATED = nothing paid yet
  world.fapshi.settle(t.transId, 'SUCCESSFUL');
  assert.equal(await payments.refreshPayment(d.paymentId), 'success');
  assert.equal(bal(U.A), 2000);
});

test('deposit: failure, expiry, wrong amount, outages, throttling, foreign payment, too many open', async () => {
  await reset();
  const T = Date.now();
  await mkUser(U.A, 1, 'Ann', 0);
  await mkUser(U.B, 2, 'Bob', 0);
  const ref = (id) => world.raw(`payments/${id}`).providerRef;

  let d = await payments.startDeposit(U.A, { amount: 1000 }, T);
  world.fapshi.settle(ref(d.paymentId), 'FAILED');
  assert.equal(await payments.refreshPayment(d.paymentId), 'failed');
  world.fapshi.settle(ref(d.paymentId), 'SUCCESSFUL'); // a late "success" for a payment we already closed
  await payments.refreshPayment(d.paymentId);
  assert.equal(bal(U.A), 0);
  assert.equal(status(d.paymentId), 'failed');

  d = await payments.startDeposit(U.A, { amount: 1000 }, T);
  world.fapshi.settle(ref(d.paymentId), 'EXPIRED');
  assert.equal(await payments.refreshPayment(d.paymentId), 'failed');

  d = await payments.startDeposit(U.A, { amount: 1000 }, T);
  world.fapshi.settle(ref(d.paymentId), 'SUCCESSFUL', { amount: 10 }); // Fapshi says a different amount
  assert.equal(await payments.refreshPayment(d.paymentId), 'review');
  assert.equal(bal(U.A), 0);
  assert.equal(world.raw(`payments/${d.paymentId}`).providerAmount, 10);
  const reviewId = d.paymentId;

  d = await payments.startDeposit(U.A, { amount: 1000 }, T);
  assert.equal(await payments.refreshPayment(d.paymentId, T + (cfg.DEPOSIT_EXPIRE_MINUTES + 1) * 60000), 'expired');

  // Fapshi refuses to start: nothing pending is left behind, player gets a safe message
  world.fapshi.rejectNext = { status: 400, body: { message: 'Direct pay is disabled' } };
  await rejects(payments.startDeposit(U.A, { amount: 1000 }, T), 'unavailable', /could not start/);
  assert.ok(![...world.store].some(([p, x]) => p.startsWith('payments/') && x.status === 'pending' && x.createdAt === T && !x.providerRef));
  world.fapshi.down = true;
  await rejects(payments.startDeposit(U.A, { amount: 1000 }, T), 'unavailable');
  world.fapshi.down = false;

  // status check outage or rate limit: stays pending, nothing credited, no crash
  d = await payments.startDeposit(U.A, { amount: 1000 }, T);
  world.fapshi.settle(ref(d.paymentId), 'SUCCESSFUL');
  world.fapshi.down = true;
  assert.equal(await payments.refreshPayment(d.paymentId), 'pending');
  world.fapshi.down = false;
  world.fapshi.throttle = true;
  assert.equal(await payments.refreshPayment(d.paymentId), 'pending');
  world.fapshi.throttle = false;
  assert.equal(await payments.refreshPayment(d.paymentId), 'success');
  assert.equal(bal(U.A), 1000);

  d = await payments.startDeposit(U.A, { amount: 1000 }, T);
  await rejects(payments.checkPayment(U.B, { paymentId: d.paymentId }), 'not-found');
  await rejects(payments.checkPayment(U.A, { paymentId: 'x' }), 'not-found');

  await mkUser(U.C, 3, 'Cy', 0);
  for (let i = 0; i < 5; i++) await payments.startDeposit(U.C, { amount: 500 }, T);
  await rejects(payments.startDeposit(U.C, { amount: 500 }, T), 'resource-exhausted');

  // an administrator settles the payment that was held for review: credit what Fapshi really received
  assert.deepEqual(await payments.adminResolve({ paymentId: reviewId, action: 'credit' }), { changed: true, status: 'success', credited: 10 });
  assert.equal(bal(U.A), 1010);
  await rejects(payments.adminResolve({ paymentId: reviewId, action: 'credit' }), 'failed-precondition');
  assert.equal(bal(U.A), 1010, 'never credited twice');
  assert.equal(ledgerSum(U.A), bal(U.A));
});

test('webhook: secret checked, payment found by id or by Fapshi reference, forged success never credits', async () => {
  await reset();
  const T = Date.now();
  await mkUser(U.A, 1, 'Ann', 0);
  const d = await payments.startDeposit(U.A, { amount: 2000 }, T);
  const transId = world.raw(`payments/${d.paymentId}`).providerRef;

  assert.deepEqual(await payments.handleFapshiWebhook(hook({}), { transId }), { code: 401, text: 'unauthorized' });
  assert.deepEqual(await payments.handleFapshiWebhook(hook({ 'x-wh-secret': 'nope' }), { transId }), { code: 401, text: 'unauthorized' });
  assert.deepEqual(await payments.handleFapshiWebhook(hook(), { transId: 'UNKNOWN' }), { code: 200, text: 'ignored' });
  assert.deepEqual(await payments.handleFapshiWebhook(hook(), null), { code: 200, text: 'ignored' });
  assert.deepEqual(await payments.handleFapshiWebhook(hook(), { externalId: 'A'.repeat(20) }), { code: 200, text: 'ignored' });

  // a forged body claiming success: Fapshi itself still says pending, so nothing is credited
  await payments.handleFapshiWebhook(hook(), { transId, externalId: d.paymentId, status: 'SUCCESSFUL', amount: 2000 });
  assert.equal(bal(U.A), 0);

  world.fapshi.settle(transId, 'SUCCESSFUL');
  await payments.handleFapshiWebhook(hook(), { transId }); // found by Fapshi reference only
  assert.equal(bal(U.A), 2000);

  cfg.FAPSHI.WEBHOOK_SECRET = ''; // secret optional: still safe, because we re-check with Fapshi
  assert.equal((await payments.handleFapshiWebhook(new Headers(), { transId })).code, 200);
  assert.equal(bal(U.A), 2000);
});

test('referral bonus: once, only for a big enough first deposit', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 0);
  const code = world.raw(`users/${U.A}`).referralCode;
  await mkUser(U.B, 2, 'Bob', 0, { referralCode: code });
  const deposit = async (amount) => {
    const d = await payments.startDeposit(U.B, { amount }, NOW);
    world.fapshi.settle(world.raw(`payments/${d.paymentId}`).providerRef, 'SUCCESSFUL');
    await payments.refreshPayment(d.paymentId);
  };
  await deposit(300); // below the minimum
  assert.equal(bal(U.A), 0);
  assert.equal(bal(U.B), 300);
  await deposit(1000);
  assert.equal(bal(U.A), cfg.REFERRAL_BONUS);
  assert.equal(world.raw(`users/${U.B}`).referralRewarded, true);
  await deposit(1000);
  assert.equal(bal(U.A), cfg.REFERRAL_BONUS); // not paid twice
  assert.equal(bal(U.B), 2300);
  assert.equal(ledgerSum(U.A), bal(U.A));
});

// ======================================================================= withdrawals
test('withdrawal: PIN needed, only to your own or an already-used number, money held, refunds exactly once', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 3000);
  const W = (extra) => ({ amount: 1000, pin: PIN, ...extra });

  await rejects(payments.requestWithdrawal(U.A, W({ amount: 100 })), 'invalid-argument');
  await rejects(payments.requestWithdrawal(U.A, W({ amount: 9000 })), 'failed-precondition', /too low/);
  await rejects(payments.requestWithdrawal(U.A, W({ pin: undefined })), 'invalid-argument');
  await rejects(payments.requestWithdrawal(U.A, W({ pin: '000111' })), 'permission-denied', /Wrong number or PIN/);
  await rejects(payments.requestWithdrawal(U.A, W({ phone: '655555555' })), 'permission-denied', /your own number/);
  assert.equal(bal(U.A), 3000);

  const w1 = await payments.requestWithdrawal(U.A, W({ phone: '6 70 00 00 01' }), NOW);
  assert.deepEqual([w1.status, w1.net, w1.fee], ['pending', 1000, 0]);
  assert.equal(bal(U.A), 2000);
  assert.equal(fapshiCalls('/payout').length, 0, 'nothing is sent without admin approval');

  const list = await payments.adminList();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].displayName, 'Ann');

  await payments.adminResolve({ paymentId: w1.paymentId, action: 'reject', note: 'name mismatch' });
  assert.equal(bal(U.A), 3000);
  assert.equal(status(w1.paymentId), 'rejected');
  assert.deepEqual(await payments.adminResolve({ paymentId: w1.paymentId, action: 'reject' }), { changed: false, status: 'rejected' });
  assert.equal(bal(U.A), 3000, 'not refunded twice');

  const w2 = await payments.requestWithdrawal(U.A, W(), NOW);
  await payments.adminResolve({ paymentId: w2.paymentId, action: 'paid' });
  assert.equal(status(w2.paymentId), 'success');
  await payments.adminResolve({ paymentId: w2.paymentId, action: 'reject' });
  assert.equal(bal(U.A), 2000, 'a paid withdrawal can never be refunded');
  await rejects(payments.adminResolve({ paymentId: w2.paymentId, action: 'nonsense' }), 'invalid-argument');
  await rejects(payments.adminResolve({ paymentId: 'short', action: 'paid' }), 'not-found');
  assert.equal(ledgerSum(U.A), bal(U.A));
});

test('withdrawal: a number you deposited from becomes allowed', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 0);
  const d = await payments.startDeposit(U.A, { amount: 3000, phone: '655555555', provider: 'orange' }, NOW);
  world.fapshi.settle(world.raw(`payments/${d.paymentId}`).providerRef, 'SUCCESSFUL');
  await payments.refreshPayment(d.paymentId);
  const w = await payments.requestWithdrawal(U.A, { amount: 1000, pin: PIN, phone: '655555555' }, NOW);
  assert.equal(w.status, 'pending');
  await rejects(payments.requestWithdrawal(U.A, { amount: 1000, pin: PIN, phone: '655555556' }, NOW), 'permission-denied');
});

test('withdrawal: send through Fapshi, success and failure, never sent twice', async () => {
  await reset();
  cfg.WITHDRAW_FEE_PERCENT = 10;
  await mkUser(U.A, 1, 'Ann', 5000);
  const mk = async (amount = 1000) => payments.requestWithdrawal(U.A, { amount, pin: PIN, provider: 'mtn' }, NOW);

  const w1 = await mk();
  assert.equal(w1.fee, 100);
  // two admins press "Send" at the same moment: exactly one payout leaves
  const both = await Promise.allSettled([payments.adminResolve({ paymentId: w1.paymentId, action: 'send' }), payments.adminResolve({ paymentId: w1.paymentId, action: 'send' })]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(fapshiCalls('/payout').length, 1);
  const [po] = fapshiCalls('/payout');
  assert.equal(po.headers.apiuser, 'payout-user');
  assert.deepEqual(po.body, { amount: 900, phone: '670000001', userId: U.A, externalId: w1.paymentId, message: 'Snake Eyes withdrawal', medium: 'mobile money' });
  assert.equal(status(w1.paymentId), 'processing');
  assert.equal(bal(U.A), 4000);
  await rejects(payments.adminResolve({ paymentId: w1.paymentId, action: 'send' }), 'failed-precondition');
  assert.deepEqual(await payments.adminResolve({ paymentId: w1.paymentId, action: 'reject' }), { changed: false, status: 'processing' }, 'cannot refund while Fapshi may still pay');

  await payments.reconcilePayments(NOW + 10 * 60 * 1000);
  assert.equal(status(w1.paymentId), 'processing'); // still pending at Fapshi
  world.fapshi.settle(world.raw(`payments/${w1.paymentId}`).providerRef, 'SUCCESSFUL');
  await payments.reconcilePayments(NOW + 10 * 60 * 1000);
  assert.equal(status(w1.paymentId), 'success');
  assert.equal(bal(U.A), 4000);

  const w2 = await mk();
  await payments.adminResolve({ paymentId: w2.paymentId, action: 'send' });
  world.fapshi.settle(world.raw(`payments/${w2.paymentId}`).providerRef, 'FAILED');
  await payments.reconcilePayments(NOW + 10 * 60 * 1000);
  assert.equal(status(w2.paymentId), 'failed');
  assert.equal(bal(U.A), 4000, 'a failed payout is refunded');
  assert.equal(ledgerSum(U.A), bal(U.A));
});

test('withdrawal: unclear payout outcomes go to review instead of guessing', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 5000);
  const mk = () => payments.requestWithdrawal(U.A, { amount: 1000, pin: PIN }, NOW);

  // Fapshi clearly refuses: back in the queue with the reason, money still held
  let w = await mk();
  world.fapshi.rejectNext = { status: 400, body: { message: 'Insufficient balance' } };
  await rejects(payments.adminResolve({ paymentId: w.paymentId, action: 'send' }), 'unavailable', /Insufficient balance/);
  assert.equal(status(w.paymentId), 'pending');
  assert.match(world.raw(`payments/${w.paymentId}`).note, /Insufficient balance/);
  assert.equal(bal(U.A), 4000);

  // the connection dies mid-payout: nobody knows whether money left
  world.fapshi.payoutBlackhole = true;
  await rejects(payments.adminResolve({ paymentId: w.paymentId, action: 'send' }), 'unavailable', /unknown/);
  world.fapshi.payoutBlackhole = false;
  assert.equal(status(w.paymentId), 'review');
  await payments.reconcilePayments(NOW + 10 * 60 * 1000);
  assert.equal(status(w.paymentId), 'review', 'automation leaves it for a human');
  assert.equal((await payments.adminList()).items.some((i) => i.id === w.paymentId), true);
  await payments.adminResolve({ paymentId: w.paymentId, action: 'reject' }); // admin checked Fapshi: nothing was sent
  assert.equal(bal(U.A), 5000);

  // a payout that was claimed but never confirmed is flagged by the cron job after 10 minutes
  w = await mk();
  const id = w.paymentId;
  await db.collection('payments').doc(id).update({ status: 'sending', updatedAt: NOW });
  await payments.reconcilePayments(NOW + 5 * 60000);
  assert.equal(status(id), 'sending');
  await payments.reconcilePayments(NOW + 11 * 60000);
  assert.equal(status(id), 'review');

  // payout keys missing: stays in the queue, with a clear message
  w = await mk();
  cfg.FAPSHI.PAYOUT_USER = '';
  await rejects(payments.adminResolve({ paymentId: w.paymentId, action: 'send' }), 'failed-precondition', /payout keys/);
  assert.equal(status(w.paymentId), 'pending');
});

test('withdrawal: small amounts are paid automatically when AUTO_PAYOUT_MAX is set', async () => {
  await reset();
  cfg.AUTO_PAYOUT_MAX = 2000;
  await mkUser(U.A, 1, 'Ann', 10000);
  const small = await payments.requestWithdrawal(U.A, { amount: 1500, pin: PIN }, NOW);
  assert.equal(small.status, 'processing');
  assert.equal(fapshiCalls('/payout').length, 1);
  const big = await payments.requestWithdrawal(U.A, { amount: 3000, pin: PIN }, NOW);
  assert.equal(big.status, 'pending');
  assert.equal(fapshiCalls('/payout').length, 1);

  world.fapshi.rejectNext = { status: 500, body: { message: 'oops' } }; // unclear failure: not shown as sent
  const odd = await payments.requestWithdrawal(U.A, { amount: 1000, pin: PIN }, NOW);
  assert.equal(odd.status, 'review');
  assert.equal(bal(U.A), 10000 - 1500 - 3000 - 1000);
  assert.equal(ledgerSum(U.A), bal(U.A));
});

test('cron: payments are re-checked in small batches, waiting withdrawals never use up the batch', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 5000);
  await payments.requestWithdrawal(U.A, { amount: 1000, pin: PIN }, NOW); // waits for admin
  await payments.requestWithdrawal(U.A, { amount: 1000, pin: PIN }, NOW);
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const d = await payments.startDeposit(U.A, { amount: 1000 }, NOW + i);
    world.fapshi.settle(world.raw(`payments/${d.paymentId}`).providerRef, 'SUCCESSFUL');
    ids.push(d.paymentId);
  }
  assert.deepEqual(await payments.reconcilePayments(NOW + 30 * 1000), { checked: 0, errors: 0, flagged: 0 }, 'too new');
  assert.equal((await payments.reconcilePayments(NOW + 5 * 60000)).checked, cfg.RECONCILE_BATCH);
  assert.equal(ids.filter((i) => status(i) === 'success').length, cfg.RECONCILE_BATCH);
  await payments.reconcilePayments(NOW + 5 * 60000);
  assert.equal(ids.filter((i) => status(i) === 'success').length, 4);
});

// ======================================================================= bookkeeping
test('the whole ledger always matches balances', async () => {
  await reset();
  await mkUser(U.A, 1, 'Ann', 2000);
  await mkUser(U.B, 2, 'Bob', 2000);
  for (let g = 0; g < 25; g++) {
    const { roomId, code } = await rooms.createRoom(U.A, { mode: 'pvp' }, NOW);
    await rooms.joinRoom(U.B, { code }, NOW);
    let room = world.raw(`rooms/${roomId}`);
    while (room.status === 'playing') {
      if (room.phase === 'stake') await rooms.startRound(U.A, { roomId, stake: room.allowed[room.allowed.length - 1] }, NOW);
      else await rooms.rollDice(room.cur.queue[0], { roomId }, NOW);
      room = world.raw(`rooms/${roomId}`);
    }
    for (const u of [U.A, U.B]) assert.equal(ledgerSum(u), bal(u));
    assert.equal(bal(U.A) + bal(U.B), 4000);
  }
});
