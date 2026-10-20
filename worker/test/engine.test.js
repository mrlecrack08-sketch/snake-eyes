import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import { normalizeCM, msisdn, operatorHint } from '../src/phone.js';

const OPT = [10, 20, 50, 100];
const mk = (mode = 'pvp') => {
  let r = E.newRoom({ code: 'ABC23', mode, visibility: 'public', hostUid: 'A', hostName: 'Ann', entryFee: 100, stakeOptions: OPT, now: 1 });
  if (mode === 'pvp') r = E.joinRoom(r, 'B', 'Bob', OPT, 2);
  return r;
};
const sumStacks = (r) => Object.values(r.players).reduce((a, p) => a + p.stack, 0);

// ---- single-round rules ----------------------------------------------------
test('highest total wins the round', () => {
  let c = E.newRound('A', 'B', 20);
  c = E.applyRoll(c, 'A', 3, 4).cur;
  const { result } = E.applyRoll(c, 'B', 6, 6);
  assert.deepEqual(result, { winner: 'B', reason: 'high' });
});

test('first roller wins on a higher total; nobody waits for a lower one', () => {
  let c = E.newRound('A', 'B', 20);
  c = E.applyRoll(c, 'A', 6, 5).cur;
  const { result } = E.applyRoll(c, 'B', 2, 4);
  assert.equal(result.winner, 'A');
});

test('two ones wins at once and the other player never rolls', () => {
  const c = E.newRound('A', 'B', 20);
  const { result, cur } = E.applyRoll(c, 'A', 1, 1);
  assert.deepEqual(result, { winner: 'A', reason: 'snake' });
  assert.equal(cur.rolls.B, undefined);
});

test('two ones from the second roller also wins', () => {
  let c = E.newRound('A', 'B', 20);
  c = E.applyRoll(c, 'A', 6, 6).cur;
  const { result } = E.applyRoll(c, 'B', 1, 1);
  assert.deepEqual(result, { winner: 'B', reason: 'snake' });
});

test('a total of 3 is eliminated even against a tiny total', () => {
  let c = E.newRound('A', 'B', 20);
  c = E.applyRoll(c, 'A', 1, 2).cur;
  assert.equal(c.rolls.A.out, true);
  assert.equal(c.rolls.A.sum, 0);
  // 2-player: the other wins immediately
  const first = E.applyRoll(E.newRound('A', 'B', 20), 'A', 2, 1);
  assert.deepEqual(first.result, { winner: 'B', reason: 'three' });
});

test('second roller rolling 3 loses to a first roller total', () => {
  let c = E.newRound('A', 'B', 20);
  c = E.applyRoll(c, 'A', 2, 2).cur;
  const { result } = E.applyRoll(c, 'B', 2, 1);
  assert.deepEqual(result, { winner: 'A', reason: 'three' });
});

test('equal highest totals: both roll again, in the same order', () => {
  let c = E.newRound('A', 'B', 20);
  c = E.applyRoll(c, 'A', 4, 4).cur;
  const r = E.applyRoll(c, 'B', 5, 3);
  assert.equal(r.result, null);
  assert.equal(r.cur.ties, 1);
  assert.deepEqual(r.cur.queue, ['A', 'B']);
  assert.deepEqual(r.cur.rolls, {});
  assert.equal(r.cur.lastTie.sum, 8);
  const again = E.applyRoll(E.applyRoll(r.cur, 'A', 6, 2).cur, 'B', 6, 3);
  assert.equal(again.result.winner, 'B');
  assert.equal(again.cur.ties, 1);
});

test('rolling out of turn is rejected', () => {
  const c = E.newRound('A', 'B', 20);
  assert.throws(() => E.applyRoll(c, 'B', 3, 3), /not your turn/);
  const done = E.applyRoll(E.applyRoll(c, 'A', 6, 6).cur, 'B', 2, 4);
  assert.throws(() => E.applyRoll(done.cur, 'A', 3, 3), /not your turn/);
});

// ---- room lifecycle -------------------------------------------------------
test('only the host picks the stake, and only an allowed one', () => {
  const r = mk();
  assert.deepEqual(r.allowed, [10, 20, 50, 100]);
  assert.throws(() => E.startRound(r, 'B', 10, 3), /host/);
  assert.throws(() => E.startRound(r, 'A', 33, 3), /not allowed/);
  assert.throws(() => E.startRound(r, 'A', 10.5, 3), /not allowed/);
  assert.equal(E.startRound(r, 'A', 20, 3).phase, 'rolling');
});

test('first roller alternates every round, host first in round 1', () => {
  let r = mk();
  const firsts = [];
  for (let i = 0; i < 4; i++) {
    r = E.startRound(r, 'A', 10, 3);
    firsts.push(r.firstUid);
    const f = r.cur.queue[0];
    const s = r.cur.queue[1];
    r = E.roll(r, f, [6, 6], OPT, 4);
    r = E.roll(r, s, [2, 4], OPT, 5);
  }
  assert.deepEqual(firsts, ['A', 'B', 'A', 'B']);
});

test('round winner takes the stake and the stakes list shrinks near the end', () => {
  let r = mk();
  r = E.startRound(r, 'A', 100, 3);
  r = E.roll(r, 'A', [6, 6], OPT, 4);
  r = E.roll(r, 'B', [2, 4], OPT, 5);
  assert.equal(r.players.A.stack, 200);
  assert.equal(r.players.B.stack, 0);
  assert.equal(r.status, 'finished');
  assert.equal(r.result.reason, 'bankrupt');
  assert.equal(r.result.winnerUid, 'A');
});

test('all-in is offered when a stack is below the smallest option', () => {
  let r = mk();
  r.players.A.stack = 105;
  r.players.B.stack = 95;
  assert.deepEqual(E.allowedStakes(r, OPT), [10, 20, 50, 95]);
  r.players.B.stack = 4;
  assert.deepEqual(E.allowedStakes(r, OPT), [4]);
});

test('cannot join your own room or a room that is already full', () => {
  const waiting = E.newRoom({ code: 'X', mode: 'pvp', visibility: 'public', hostUid: 'A', hostName: 'Ann', entryFee: 100, stakeOptions: OPT, now: 1 });
  assert.throws(() => E.joinRoom(waiting, 'A', 'Ann', OPT, 2), /already in/);
  const full = E.joinRoom(waiting, 'B', 'Bob', OPT, 2);
  assert.throws(() => E.joinRoom(full, 'C', 'Cy', OPT, 3), /not open/);
});

test('forfeit mid-game hands the whole stack to the other player', () => {
  let r = mk();
  r = E.startRound(r, 'A', 50, 3);
  r = E.roll(r, 'A', [6, 6], OPT, 4);
  r = E.roll(r, 'B', [2, 4], OPT, 5); // A 150, B 50
  const f = E.forfeit(r, 'A', 6);
  assert.equal(f.result.winnerUid, 'B');
  assert.equal(f.result.stacks.B, 200);
  assert.equal(f.result.stacks.A, 0);
});

test('leaving before any round is played refunds both players', () => {
  const r = mk();
  const f = E.forfeit(r, 'B', 5);
  assert.equal(f.result.reason, 'cancelled');
  assert.deepEqual(E.computePayouts(f, 10), { payouts: { A: 100, B: 100 }, rake: 0 });
});

test('waiting room can be cancelled with a refund', () => {
  const w = E.newRoom({ code: 'X', mode: 'pvp', visibility: 'public', hostUid: 'A', hostName: 'Ann', entryFee: 100, stakeOptions: OPT, now: 1 });
  const c = E.cancel(w, 9);
  assert.deepEqual(E.computePayouts(c, 0).payouts, { A: 100 });
});

test('timeouts: waiting room cancels, idle roller forfeits, idle host forfeits', () => {
  const w = E.newRoom({ code: 'X', mode: 'pvp', visibility: 'public', hostUid: 'A', hostName: 'Ann', entryFee: 100, stakeOptions: OPT, now: 1 });
  assert.equal(E.timeout(w, 9).result.reason, 'cancelled');

  let r = mk();
  assert.equal(E.timeout(r, 9).result.reason, 'cancelled'); // no round played yet

  r = E.startRound(r, 'A', 10, 3);
  r = E.roll(r, 'A', [6, 6], OPT, 4);
  const t = E.timeout(r, 9); // B should roll and did not
  assert.equal(t.result.winnerUid, 'A');
  assert.equal(t.result.reason, 'timeout');

  r = E.roll(r, 'B', [2, 4], OPT, 5);
  const t2 = E.timeout(r, 9); // host should pick a stake and did not
  assert.equal(t2.result.winnerUid, 'B');
});

// ---- practice (COM) --------------------------------------------------------
test('COM rolls instantly and the practice room never produces payouts', () => {
  let r = mk('ai');
  assert.equal(r.status, 'playing');
  const seq = [4, 4, 6, 5, 3, 3, 2, 5, 6, 6, 1, 1];
  let i = 0;
  const rng = () => seq[i++ % seq.length];
  r = E.startRound(r, 'A', 20, 3);
  r = E.autoPlay(r, OPT, 4, rng); // A is first, so COM waits
  assert.equal(r.cur.queue[0], 'A');
  r = E.roll(r, 'A', [3, 3], OPT, 5);
  r = E.autoPlay(r, OPT, 5, rng);
  assert.equal(r.phase, 'stake');
  assert.deepEqual(E.computePayouts({ ...r, status: 'finished', result: { stacks: {}, reason: 'bankrupt' } }, 10), { payouts: {}, rake: 0 });
});

test('COM goes first in round 2 and the engine continues until the human must roll', () => {
  let r = mk('ai');
  r = E.startRound(r, 'A', 10, 3);
  r = E.roll(r, 'A', [6, 6], OPT, 4);
  r = E.autoPlay(r, OPT, 4, () => 2); // COM 4 -> loses; round over
  assert.equal(r.phase, 'stake');
  r = E.startRound(r, 'A', 10, 5);
  assert.equal(r.firstUid, 'AI');
  r = E.autoPlay(r, OPT, 5, () => 3); // COM rolls 6
  assert.equal(r.cur.rolls.AI.sum, 6);
  assert.deepEqual(r.cur.queue, ['A']);
});

// ---- money safety ----------------------------------------------------------
test('payouts balance exactly, with and without a platform fee', () => {
  for (const pct of [0, 5, 10, 33]) {
    for (const reason of ['bankrupt', 'forfeit', 'timeout']) {
      for (const winnerStack of [101, 150, 177, 200]) {
        const room = {
          mode: 'pvp', entryFee: 100, playerUids: ['A', 'B'],
          result: { reason, stacks: { A: winnerStack, B: 200 - winnerStack } },
        };
        const { payouts, rake } = E.computePayouts(room, pct);
        assert.equal(payouts.A + payouts.B + rake, 200);
        assert.ok(payouts.A >= 0 && payouts.B >= 0 && rake >= 0);
        assert.ok(Number.isInteger(payouts.A) && Number.isInteger(payouts.B) && Number.isInteger(rake));
      }
    }
  }
});

test('fee is taken only from profit, never from the entry', () => {
  const room = { mode: 'pvp', entryFee: 100, playerUids: ['A', 'B'], result: { reason: 'bankrupt', stacks: { A: 200, B: 0 } } };
  assert.deepEqual(E.computePayouts(room, 10), { payouts: { A: 190, B: 0 }, rake: 10 });
});

test('simulation: 20 000 random pvp games conserve money and always end', () => {
  for (let g = 0; g < 20000; g++) {
    let r = mk();
    let steps = 0;
    while (r.status === 'playing') {
      if (++steps > 5000) assert.fail('game did not end');
      if (r.phase === 'stake') {
        const stake = r.allowed[Math.floor(Math.random() * r.allowed.length)];
        r = E.startRound(r, 'A', stake, steps);
      } else {
        const who = r.cur.queue[0];
        r = E.roll(r, who, [E.randomDie(), E.randomDie()], OPT, steps);
      }
      assert.equal(sumStacks(r), 200);
      for (const u of r.order) assert.ok(r.players[u].stack >= 0);
    }
    assert.equal(r.status, 'finished');
    const { payouts, rake } = E.computePayouts(r, 10);
    assert.equal(payouts.A + payouts.B + rake, 200);
    assert.ok(r.players.A.stack === 0 || r.players.B.stack === 0);
  }
});

test('simulation: dice are fair enough that neither side has a real edge', () => {
  let aWins = 0;
  const N = 20000;
  for (let g = 0; g < N; g++) {
    let r = mk();
    while (r.status === 'playing') {
      if (r.phase === 'stake') r = E.startRound(r, 'A', 100, 1);
      else r = E.roll(r, r.cur.queue[0], [E.randomDie(), E.randomDie()], OPT, 1);
    }
    if (r.result.winnerUid === 'A') aWins++;
  }
  const rate = aWins / N;
  assert.ok(rate > 0.47 && rate < 0.53, `host won ${rate}`);
});

// ---- phone -----------------------------------------------------------------
test('Cameroon phone numbers normalise to +237 format', () => {
  for (const ok of ['670123456', '6 70 12 34 56', '+237670123456', '237670123456', '00237 670 123 456', '+237 6-70-12-34-56']) {
    assert.equal(normalizeCM(ok), '+237670123456', ok);
  }
  for (const bad of ['', '12345', '+33612345678', '570123456', '67012345', '6701234567', null, 670123456, '+2372123456789']) {
    assert.equal(normalizeCM(bad), null, String(bad));
  }
  assert.equal(msisdn('+237670123456'), '237670123456');
  assert.equal(operatorHint('+237670123456'), 'mtn');
  assert.equal(operatorHint('+237690123456'), 'orange');
  assert.equal(operatorHint('+237660123456'), null);
});
