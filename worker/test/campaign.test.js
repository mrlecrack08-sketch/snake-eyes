// Bet-before-withdraw, promo codes with a bonus section, partners and their commission, demo accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, env } from './helpers/world.js';
import { cfg, configure } from '../src/config.js';
import { db, setDb } from '../src/fb.js';
import { Firestore } from '../src/firestore.js';
import { accessTokenSource, parseServiceAccount } from '../src/google.js';
import * as auth from '../src/auth.js';
import * as rooms from '../src/rooms.js';
import * as payments from '../src/payments.js';
import * as partners from '../src/partners.js';
import * as house from '../src/house.js';
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
const user = (u) => world.raw(`users/${u}`);
const bal = (u) => user(u).balance;
const rejects = (p, code, re) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); if (re) assert.match(e.message, re); return true; });

// the real settings (not the small ones the older tests use), with play-through switched on
const prodEnv = () => {
  const { BUY_IN_OPTIONS, STAKE_OPTIONS, ROOM_FEE, MIN_DEPOSIT, MIN_WITHDRAW, AUTO_PAYOUT_MAX, PLAY_THROUGH, ...rest } = env;
  return { ...rest, ROOM_FEE: '0' };
};
const reset = (extra = {}) => { world.reset(); configure({ ...prodEnv(), ...extra }); };

async function mkUser(n, name, balance = 0, extra = {}) {
  const uid = uidFromPhone(phoneOf(n));
  await auth.register({ phone: phoneOf(n), pin: PIN, displayName: name, adult: true, ...extra }, NOW);
  if (balance) {
    await db.runTransaction(async (tx) => {
      const m = await readUsers(tx, [uid]);
      credit(tx, m[uid], balance, 'deposit', 'seed', NOW); // seeded money has no play-through, like an older account
      flush(tx, m, NOW);
    });
  }
  return uid;
}

/** A real deposit, paid through the fake Fapshi. */
async function deposit(uid, amount, { promoCode } = {}) {
  const fn = promoCode ? payments.startPromoDeposit : payments.startDeposit;
  const d = await fn(uid, { amount, phone: user(uid).phone.replace('+237', ''), provider: 'mtn', code: promoCode }, Date.now());
  const ref = world.raw(`payments/${d.paymentId}`).providerRef;
  world.fapshi.settle(ref, 'SUCCESSFUL');
  assert.equal(await payments.refreshPayment(d.paymentId), 'success');
  return d.paymentId;
}

async function playOut(roomId, uid, stake) {
  let room = world.raw(`rooms/${roomId}`);
  let guard = 0;
  while (room.status === 'playing' && guard++ < 800) {
    if (room.phase === 'stake') await rooms.startRound(uid, { roomId, stake: stake && room.allowed.includes(stake) ? stake : room.allowed[room.allowed.length - 1] }, NOW);
    else await rooms.rollDice(room.cur.queue[0], { roomId }, NOW);
    room = world.raw(`rooms/${roomId}`);
  }
  assert.equal(room.status, 'finished');
  return room;
}

const houseRaw = () => world.raw('users/house') || { balance: 0, stats: {} };
/** Every XAF in the system: wallets (incl. house, partners), promo sections, and money sitting in rooms. */
const totalMoney = () => [...world.store].filter(([p]) => /^users\/[^/]+$/.test(p)).reduce((a, [, d]) => a + (d.balance || 0) + ((d.promo && d.promo.balance) || 0), 0)
  + [...world.store].filter(([p]) => /^rooms\/[^/]+$/.test(p)).reduce((a, [, r]) => a + (r.status === 'finished' ? 0 : Object.values(r.players).reduce((x, pl) => x + pl.stack, 0)), 0);

// ======================================================================= bet before you withdraw
test('play-through: a deposit has to be bet before it can be withdrawn; winnings and old balances are free', async () => {
  reset({ PLAY_THROUGH: '100', MIN_WITHDRAW: '500' });
  const A = await mkUser(1, 'Ann', 3000); // seeded: nothing to play through
  await deposit(A, 1000);
  assert.equal(bal(A), 4000);
  assert.equal(user(A).unplayed, 1000, 'the deposit is marked as not yet bet');

  await rejects(payments.requestWithdrawal(A, { amount: 3500, pin: PIN, phone: phoneOf(1) }, NOW), 'failed-precondition', /up to 3000 XAF/);
  assert.equal(bal(A), 4000, 'a refused withdrawal takes nothing');
  const w = await payments.requestWithdrawal(A, { amount: 3000, pin: PIN, phone: phoneOf(1) }, NOW);
  assert.equal(w.net, 3000);
  assert.equal(bal(A), 1000);
  await rejects(payments.requestWithdrawal(A, { amount: 500, pin: PIN, phone: phoneOf(1) }, NOW), 'failed-precondition', /must bet your deposit/);

  // Bet it: a computer-table room of 1000. Whatever the result, the deposit counts as played.
  await house.houseTopUp({ amount: 20000 }, NOW);
  const r = await rooms.createRoom(A, { mode: 'house', buyIn: 1000 }, NOW);
  assert.equal(bal(A), 0);
  const room = await playOut(r.roomId, A);
  assert.ok(room.wagered >= 1000, 'a room only ends when 1000 has been lost, so at least 1000 was bet');
  assert.equal(user(A).unplayed, 0, 'bet it once: nothing left to play through');
  if (bal(A) >= 500) {
    await payments.requestWithdrawal(A, { amount: bal(A), pin: PIN, phone: phoneOf(1) }, NOW);
    assert.equal(bal(A), 0);
  }
});

test('play-through: a deposit that is only partly bet frees only the bet part; winnings never need betting', async () => {
  reset({ PLAY_THROUGH: '100', MIN_WITHDRAW: '100', STAKE_OPTIONS: '100,250' });
  const A = await mkUser(1, 'Ann', 0);
  await deposit(A, 2000);
  await house.houseTopUp({ amount: 20000 }, NOW);
  const r = await rooms.createRoom(A, { mode: 'house', buyIn: 500 }, NOW); // 500 of the 2000 goes on the table
  const room = await playOut(r.roomId, A, 100);
  const u = user(A);
  assert.equal(u.unplayed, Math.min(Math.max(0, 2000 - room.wagered), u.balance), 'only what was bet is freed, never more than the balance');
  const free = u.balance - u.unplayed;
  assert.ok(free >= 0 && free <= u.balance);
  if (free > 0) await payments.requestWithdrawal(A, { amount: free, pin: PIN, phone: phoneOf(1) }, NOW);
  await rejects(payments.requestWithdrawal(A, { amount: bal(A) + 1000, pin: PIN, phone: phoneOf(1) }, NOW), 'failed-precondition');
});

test('play-through: it can be switched off, and the old behaviour is unchanged for existing accounts', async () => {
  reset({ PLAY_THROUGH: '0', MIN_WITHDRAW: '500' });
  const A = await mkUser(1, 'Ann', 0);
  await deposit(A, 1000);
  assert.ok(!user(A).unplayed);
  await payments.requestWithdrawal(A, { amount: 1000, pin: PIN, phone: phoneOf(1) }, NOW);
  assert.equal(bal(A), 0);
});

// ======================================================================= partners and promo codes
async function mkPartner(extra = {}) {
  return partners.partnerAdd({ name: 'Caire', phone: '690000009', code: 'caire1', ...extra }, NOW);
}

test('partners: add one, codes are unique and cannot shadow a player referral code, deactivating blocks the code', async () => {
  reset();
  await rejects(partners.partnerAdd({ name: 'X', phone: '690000009' }, NOW), 'invalid-argument');
  await rejects(partners.partnerAdd({ name: 'Caire', phone: '123' }, NOW), 'invalid-argument', /mobile money number/);
  const p = await mkPartner();
  assert.equal(p.code, 'CAIRE1');
  assert.equal(world.raw('partners/caire1').phone, '+237690000009');
  assert.equal(world.raw('users/p_caire1').isPartner, true);
  await rejects(partners.partnerAdd({ name: 'Other', phone: '690000008', code: 'CAIRE1' }, NOW), 'already-exists');

  const A = await mkUser(1, 'Ann', 0);
  await rejects(partners.partnerAdd({ name: 'Shadow', phone: '690000008', code: user(A).referralCode }, NOW), 'already-exists');

  const auto = await partners.partnerAdd({ name: 'Marie Jo', phone: '690000007' }, NOW);
  assert.match(auto.code, /^MARIEJ[A-Z]{2}$/);

  assert.equal((await partners.promoCheck(A, { code: ' caire1 ' })).partnerName, 'Caire');
  await partners.partnerSetActive({ id: 'caire1', active: false });
  await rejects(partners.promoCheck(A, { code: 'CAIRE1' }), 'not-found');
  await rejects(auth.register({ phone: phoneOf(2), pin: PIN, displayName: 'Bob', adult: true, referralCode: 'CAIRE1' }, NOW), 'not-found', /no longer active/);
  await partners.partnerSetActive({ id: 'caire1', active: true });
  await partners.promoCheck(A, { code: 'CAIRE1' });
});

test('partners: a player who signs up with the code is listed under that partner, and the first deposit pays 10 %', async () => {
  reset();
  await mkPartner();
  await house.houseTopUp({ amount: 10000 }, NOW);
  const B = await mkUser(2, 'Bob', 0, { referralCode: 'caire1' });
  assert.equal(user(B).partnerId, 'caire1');
  assert.equal(user(B).referredBy, null, 'a partner code is not a friend referral');
  let refs = (await partners.referralsList({})).items;
  assert.equal(refs.length, 1);
  assert.deepEqual([refs[0].name, refs[0].partnerName, refs[0].via, refs[0].firstDeposit], ['Bob', 'Caire', 'signup', null]);

  await deposit(B, 3000);
  assert.equal(bal(B), 3000, 'a normal deposit goes to the normal balance');
  assert.equal(bal('p_caire1'), 300, '10 % of the first deposit');
  assert.equal(houseRaw().balance, 10000 - 300, 'the commission is a cost carried by the house');
  refs = (await partners.referralsList({})).items;
  assert.deepEqual([refs[0].firstDeposit, refs[0].commission], [3000, 300]);

  await deposit(B, 2000);
  assert.equal(bal('p_caire1'), 300, 'only the first deposit pays a commission');

  const list = await partners.partnerList();
  const row = list.items[0];
  assert.deepEqual([row.joined, row.deposited, row.depositTotal, row.earned, row.owed, row.paid], [1, 1, 3000, 300, 300, 0]);
});

test('partners: paying a partner goes to THEIR saved number, is held first, and a failed payout is refunded to what they are owed', async () => {
  reset({ PARTNER_MIN_PAYOUT: '200' });
  await mkPartner();
  const B = await mkUser(2, 'Bob', 0, { referralCode: 'caire1' });
  await deposit(B, 3000);
  await rejects(partners.partnerPay({ id: 'caire1', amount: 100 }, NOW), 'invalid-argument');
  await rejects(partners.partnerPay({ id: 'caire1', amount: 500 }, NOW), 'failed-precondition', /only owed 300/);
  await rejects(partners.partnerPay({ id: 'nobody', amount: 300 }, NOW), 'not-found');

  world.fapshi.rejectNext = { status: 400, body: { message: 'insufficient funds' } };
  const r = await partners.partnerPay({ id: 'caire1', amount: 300 }, NOW);
  assert.equal(r.phone, '+237690000009');
  assert.equal(bal('p_caire1'), 0, 'held while the payout is open');
  const pay = world.raw(`payments/${r.paymentId}`);
  assert.equal(pay.uid, 'p_caire1');
  assert.equal(pay.status, 'pending');
  await payments.adminResolve({ paymentId: r.paymentId, action: 'reject', note: 'try later' });
  assert.equal(bal('p_caire1'), 300, 'rejected: back to what they are owed, once');
  await payments.adminResolve({ paymentId: r.paymentId, action: 'reject' });
  assert.equal(bal('p_caire1'), 300);

  const ok = await partners.partnerPay({ id: 'caire1', amount: 300 }, NOW);
  const call = world.fapshi.calls.filter((c) => c.pathname === '/payout').pop();
  assert.equal(call.body.phone, '690000009');
  assert.ok(['processing', 'success'].includes(world.raw(`payments/${ok.paymentId}`).status));
  const row = (await partners.partnerList()).items[0];
  assert.deepEqual([row.earned, row.owed, row.paid], [300, 0, 300]);
});

// ======================================================================= promo bonus
test('promo: 5000 with a code becomes 10000 in a separate section, never in the normal balance', async () => {
  reset();
  await mkPartner();
  const A = await mkUser(1, 'Ann', 0);
  await rejects(payments.startPromoDeposit(A, { code: 'NOPE99', amount: 5000 }), 'not-found');
  await rejects(payments.startPromoDeposit(A, { code: 'caire1', amount: 4000 }), 'invalid-argument', /between 5000 and 10000/);
  await rejects(payments.startPromoDeposit(A, { code: 'caire1', amount: 20000 }), 'invalid-argument');
  assert.equal(user(A).partnerId, undefined, 'a refused promo deposit links nothing');

  await deposit(A, 5000, { promoCode: 'caire1' });
  const u = user(A);
  assert.equal(u.balance, 0, 'the normal balance is untouched');
  assert.deepEqual([u.promo.balance, u.promo.deposit, u.promo.bonus, u.promo.wagerLeft], [10000, 5000, 5000, 25000]);
  assert.equal(u.partnerId, 'caire1');
  assert.equal(houseRaw().stats.promoBonus, 5000);
  assert.equal(houseRaw().balance, -5000 - 500, 'the bonus and the partner commission are costs of the house');
  assert.equal(bal('p_caire1'), 500);
  const lines = [...world.store].filter(([p]) => p.startsWith(`users/${A}/transactions/`)).map(([, d]) => d);
  assert.deepEqual(lines.filter((l) => l.section === 'promo').map((l) => [l.type, l.amount]).sort(), [['promo_bonus', 5000], ['promo_deposit', 5000]]);

  await rejects(payments.startPromoDeposit(A, { code: 'caire1', amount: 5000 }), 'failed-precondition', /already used/);

  // a second partner cannot take over a player who already belongs to the first
  await partners.partnerAdd({ name: 'Marie', phone: '690000007', code: 'marie1' }, NOW);
  const B = await mkUser(2, 'Bob', 0, { referralCode: 'caire1' });
  await rejects(payments.startPromoDeposit(B, { code: 'marie1', amount: 5000 }), 'failed-precondition', /another code/);
});

test('promo: the bonus can only be played against the computer; 25000 must be bet before it can be withdrawn', async () => {
  reset({ PROMO_WAGER: '1000', MIN_WITHDRAW: '500' });
  await mkPartner();
  const A = await mkUser(1, 'Ann', 0);
  await deposit(A, 5000, { promoCode: 'caire1' });
  await house.houseTopUp({ amount: 30000 }, NOW);
  const total = totalMoney();

  await rejects(rooms.createRoom(A, { mode: 'pvp', buyIn: 500 }, NOW), 'failed-precondition', /Add money first/); // pvp uses the normal balance only
  await rejects(rooms.createRoom(A, { mode: 'house', buyIn: 500 }, NOW), 'failed-precondition', /Add money first/); // so does the computer table, unless you ask for the bonus
  await rejects(payments.requestWithdrawal(A, { amount: 500, pin: PIN, phone: phoneOf(1) }, NOW), 'failed-precondition', /too low/); // nothing in the normal balance

  const r = await rooms.createRoom(A, { mode: 'house', buyIn: 5000, useBonus: true }, NOW);
  assert.equal(user(A).promo.balance, 5000);
  assert.equal(world.raw(`rooms/${r.roomId}`).fundedBy, 'promo');
  assert.equal(totalMoney(), total, 'money only moves around');
  const room = await playOut(r.roomId, A);
  assert.ok(room.wagered >= 5000);

  const u = user(A);
  assert.equal(u.promo, null, 'the wager (1000 here) is done, so the promo is closed');
  assert.equal(u.promoStatus, 'unlocked');
  assert.ok(u.balance === 5000 || u.balance === 15000, `what is left moves to the normal balance (${u.balance})`);
  assert.equal(totalMoney(), total);
  assert.equal(u.unplayed || 0, 0, 'promo money needs no further play-through: the wager was the play-through');
  if (u.balance >= 500) {
    await payments.requestWithdrawal(A, { amount: u.balance, pin: PIN, phone: phoneOf(1) }, NOW);
    assert.equal(bal(A), 0);
  }
});

test('promo: the wager counts only bonus money bet against the computer, and what is not yet wagered stays locked', async () => {
  reset({ PROMO_WAGER: '25000' });
  await mkPartner();
  const A = await mkUser(1, 'Ann', 0);
  await deposit(A, 5000, { promoCode: 'caire1' });
  await house.houseTopUp({ amount: 60000 }, NOW);
  const total = totalMoney();

  let guard = 0;
  while (user(A).promo && guard++ < 200) {
    const left = user(A).promo.balance;
    const buyIn = [10000, 5000, 2000, 1000, 500, 250].find((o) => o <= left);
    const r = await rooms.createRoom(A, { mode: 'house', buyIn, useBonus: true }, NOW);
    const before = user(A).promo ? user(A).promo.wagerLeft : null;
    const room = await playOut(r.roomId, A);
    const u = user(A);
    if (u.promo) assert.equal(u.promo.wagerLeft, Math.max(0, before - room.wagered), 'each finished round counts toward the wager');
    assert.equal(bal(A) + ((u.promo && u.promo.balance) || 0) + (u.promoStatus === 'unlocked' ? 0 : 0) >= 0, true);
    assert.equal(totalMoney(), total, 'no money is created or lost on the way');
  }
  const u = user(A);
  assert.ok(['unlocked', 'lost'].includes(u.promoStatus), `the promo ends one way or the other (${u.promoStatus})`);
  if (u.promoStatus === 'lost') assert.equal(bal(A), 0);
  else assert.ok(bal(A) >= 0);
  await rejects(payments.startPromoDeposit(A, { code: 'caire1', amount: 5000 }), 'failed-precondition', /already used/);
});

test('promo: giving up with the bonus after a round loses it and ends the promo; a cancelled room gives it back', async () => {
  reset({ PROMO_WAGER: '25000' });
  await mkPartner();
  const A = await mkUser(1, 'Ann', 0);
  await deposit(A, 5000, { promoCode: 'caire1' });
  await house.houseTopUp({ amount: 30000 }, NOW);

  const c = await rooms.createRoom(A, { mode: 'house', buyIn: 5000, useBonus: true }, NOW);
  assert.equal(user(A).promo.balance, 5000);
  await rooms.forfeitRoom(A, { roomId: c.roomId }, NOW); // before any round: everything comes back
  assert.equal(user(A).promo.balance, 10000, 'refunded to the bonus section, not to the normal balance');
  assert.equal(user(A).promo.wagerLeft, 25000, 'a cancelled room counts for nothing');
  assert.equal(bal(A), 0);

  const r = await rooms.createRoom(A, { mode: 'house', buyIn: 10000, useBonus: true }, NOW);
  let room = world.raw(`rooms/${r.roomId}`);
  await rooms.startRound(A, { roomId: r.roomId, stake: room.allowed[0] }, NOW);
  await rooms.forfeitRoom(A, { roomId: r.roomId }, NOW);
  const u = user(A);
  assert.equal(u.promo, null);
  assert.equal(u.promoStatus, 'lost');
  assert.equal(bal(A), 0);
});

// ======================================================================= demo accounts
test('demo accounts: fictitious money set from /Crack, apart from the real house, no deposit, no withdrawal, no promo', async () => {
  reset({ MIN_WITHDRAW: '500' });
  await mkPartner();
  const d1 = await partners.demoCreate({ name: 'Caire Demo', phone: '600000001', pin: PIN, balance: 20000, partnerId: 'caire1' });
  const d2 = await partners.demoCreate({ name: 'Marie Demo', phone: '600000002', pin: PIN, balance: 20000 });
  await rejects(partners.demoCreate({ name: 'Again', phone: '600000001', pin: PIN }), 'already-exists');
  await rejects(partners.demoCreate({ name: 'Bad Pin', phone: '600000003', pin: '123456' }), 'invalid-argument');
  await rejects(partners.demoCreate({ name: 'Neg', phone: '600000003', pin: PIN, balance: -5 }), 'invalid-argument');
  assert.equal(user(d1.uid).demo, true);
  assert.equal((await auth.login({ phone: '600000001', pin: PIN }, NOW)).uid, d1.uid, 'a demo account signs in like any other');

  await rejects(payments.startDeposit(d1.uid, { amount: 1000, phone: '600000001', provider: 'mtn' }), 'failed-precondition', /fictitious/);
  await rejects(payments.requestWithdrawal(d1.uid, { amount: 1000, pin: PIN, phone: '600000001' }, NOW), 'failed-precondition', /fictitious/);
  await rejects(payments.startPromoDeposit(d1.uid, { amount: 5000, code: 'caire1', phone: '600000001', provider: 'mtn' }), 'failed-precondition', /Demo accounts/);

  const real = await mkUser(1, 'Ann', 5000);
  const before = { house: houseRaw().balance || 0, real: bal(real) };

  // demo vs demo, with the room fee: the real house earns nothing
  const r = await rooms.createRoom(d1.uid, { mode: 'pvp', buyIn: 1000, visibility: 'public' }, NOW);
  const room0 = world.raw(`rooms/${r.roomId}`);
  assert.equal(room0.demo, true);
  assert.equal(room0.visibility, 'private', 'demo rooms never show up in the public list');
  await rejects(rooms.joinRoom(real, { code: r.code }, NOW), 'permission-denied', /Demo accounts/);
  await rooms.joinRoom(d2.uid, { code: r.code }, NOW);
  await playOut(r.roomId, d1.uid, 250);
  assert.equal(bal(d1.uid) + bal(d2.uid), 40000 - 2 * cfg.ROOM_FEE, 'the demo money moves between the demo players');

  // demo vs the computer works without any real house money
  const c = await rooms.createRoom(d1.uid, { mode: 'house', buyIn: 1000 }, NOW);
  const room = await playOut(c.roomId, d1.uid, 250);
  assert.equal(room.status, 'finished');
  assert.deepEqual([houseRaw().balance || 0, bal(real)], [before.house, before.real], 'the real house and real players are untouched');
  assert.ok(!houseRaw().stats || !houseRaw().stats.comNet, 'demo games do not count in the house results');

  // a real room cannot be joined by a demo account
  const rr = await rooms.createRoom(real, { mode: 'pvp', buyIn: 500 }, NOW);
  await rejects(rooms.joinRoom(d1.uid, { code: rr.code }, NOW), 'permission-denied', /Demo accounts/);
  await rooms.cancelRoom(real, { roomId: rr.roomId }, NOW);
});

test('demo accounts: the owner sets the fictitious balance exactly, and only on demo accounts', async () => {
  reset();
  const d = await partners.demoCreate({ name: 'Caire Demo', phone: '600000001', pin: PIN, balance: 1000 });
  const real = await mkUser(2, 'Bob', 500);
  assert.equal((await partners.demoSetBalance({ uid: d.uid, balance: 50000 }, NOW)).balance, 50000);
  assert.equal(bal(d.uid), 50000);
  await partners.demoSetBalance({ uid: d.uid, balance: 200 }, NOW);
  assert.equal(bal(d.uid), 200);
  await rejects(partners.demoSetBalance({ uid: real, balance: 99999 }, NOW), 'failed-precondition', /not a demo/);
  assert.equal(bal(real), 500, 'a real account can never be changed this way');
  await rejects(partners.demoSetBalance({ uid: d.uid, balance: -1 }, NOW), 'invalid-argument');
  await rejects(partners.demoSetBalance({ uid: d.uid, balance: 1.5 }, NOW), 'invalid-argument');
  const list = (await partners.demoList()).items;
  assert.deepEqual(list.map((x) => [x.name, x.balance]), [['Caire Demo', 200]]);
});
