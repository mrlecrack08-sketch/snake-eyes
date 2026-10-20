/**
 * Pure game engine. No database, no network, no clock: everything comes in as arguments,
 * so it can be tested exhaustively. The Firestore layer (rooms.js) only moves state in and out.
 *
 * Money model
 *   - Each player puts `entryFee` into the room. That becomes their room stack.
 *   - Each round the host picks a stake. The round winner takes `stake` from the loser's stack.
 *   - The room ends when one stack hits zero, or when someone forfeits (their whole stack goes
 *     to the other player). Remaining stacks are paid back to wallets (minus the optional fee).
 *
 * Round rules
 *   - Roll two dice, total = sum. Highest total wins the round.
 *   - Equal highest totals: only those players roll again.
 *   - A total of 3 counts as zero and eliminates that player from the round.
 *   - A total of 2 (two ones) wins the round immediately for whoever rolls it.
 */

const AI_UID = 'AI';
const HISTORY_CAP = 40;

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code; // matches Firebase HttpsError codes
  }
}

/** Fair die from the platform's secure random source (rejection sampling, no modulo bias). */
const randomDie = () => {
  const buf = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < 252) return (buf[0] % 6) + 1; // 252 = 6 * 42
  }
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const otherOf = (room, uid) => room.order.find((u) => u !== uid);

// ---------------------------------------------------------------- stakes
function allowedStakes(room, options) {
  const stacks = room.order.map((u) => room.players[u].stack);
  const m = Math.min(...stacks);
  if (!(m > 0)) return [];
  const set = new Set(options.filter((s) => s <= m));
  set.add(m); // the smaller stack can always go all-in
  return [...set].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- one round
function newRound(first, second, stake) {
  return { stake, queue: [first, second], contenders: [first, second], rolls: {}, ties: 0, lastTie: null, done: false };
}

/** Apply one player's roll. Returns { cur, result } where result is null while the round continues. */
function applyRoll(cur, uid, d1, d2) {
  if (cur.done || !cur.queue.length || cur.queue[0] !== uid) throw new GameError('failed-precondition', 'It is not your turn to roll.');
  const next = clone(cur);
  next.queue.shift();
  const raw = d1 + d2;
  const out = raw === 3;
  next.rolls[uid] = { d: [d1, d2], sum: out ? 0 : raw, out };

  if (raw === 2) return { cur: next, result: { winner: uid, reason: 'snake' } };

  if (out) {
    next.contenders = next.contenders.filter((u) => u !== uid);
    if (next.contenders.length === 1) return { cur: next, result: { winner: next.contenders[0], reason: 'three' } };
  }

  if (next.queue.length === 0) {
    const max = Math.max(...next.contenders.map((u) => next.rolls[u].sum));
    const top = next.contenders.filter((u) => next.rolls[u].sum === max);
    if (top.length === 1) return { cur: next, result: { winner: top[0], reason: 'high' } };
    // Tie: only the tied players roll again.
    next.lastTie = { sum: max, players: top, rolls: top.reduce((a, u) => ({ ...a, [u]: next.rolls[u] }), {}) };
    next.ties += 1;
    next.contenders = top;
    next.queue = top.slice();
    next.rolls = {};
  }
  return { cur: next, result: null };
}

// ---------------------------------------------------------------- room lifecycle
function newRoom({ code, mode, visibility, hostUid, hostName, entryFee, stakeOptions, now }) {
  const room = {
    code: code || null,
    mode, // 'pvp' real money, 'ai' practice with virtual chips
    practice: mode === 'ai',
    visibility: mode === 'ai' ? 'private' : visibility,
    status: 'waiting', // waiting | playing | finished
    phase: 'waiting', // waiting | stake | rolling | over
    entryFee,
    hostUid,
    playerUids: [hostUid],
    order: [hostUid],
    players: { [hostUid]: { name: hostName, stack: entryFee } },
    round: 0,
    firstUid: hostUid,
    stake: 0,
    allowed: [],
    cur: null,
    last: null,
    history: [],
    result: null,
    settled: false,
    createdAt: now,
    updatedAt: now,
  };
  if (mode === 'ai') {
    room.status = 'playing';
    room.phase = 'stake';
    room.order = [hostUid, AI_UID];
    room.players[AI_UID] = { name: 'COM', stack: entryFee };
    room.allowed = allowedStakes(room, stakeOptions);
  }
  return room;
}

function joinRoom(room, uid, name, stakeOptions, now) {
  if (room.status !== 'waiting' || room.mode !== 'pvp') throw new GameError('failed-precondition', 'This room is not open.');
  if (room.playerUids.includes(uid)) throw new GameError('failed-precondition', 'You are already in this room.');
  const r = clone(room);
  r.playerUids.push(uid);
  r.order.push(uid);
  r.players[uid] = { name, stack: r.entryFee };
  r.status = 'playing';
  r.phase = 'stake';
  r.allowed = allowedStakes(r, stakeOptions);
  r.updatedAt = now;
  return r;
}

function startRound(room, uid, stake, now) {
  if (room.status !== 'playing' || room.phase !== 'stake') throw new GameError('failed-precondition', 'A round cannot start right now.');
  if (uid !== room.hostUid) throw new GameError('permission-denied', 'Only the host picks the stake.');
  if (!Number.isInteger(stake) || !room.allowed.includes(stake)) throw new GameError('invalid-argument', 'That stake is not allowed.');
  const r = clone(room);
  r.round += 1;
  r.firstUid = r.order[(r.round - 1) % 2];
  const second = otherOf(r, r.firstUid);
  r.stake = stake;
  r.cur = newRound(r.firstUid, second, stake);
  r.phase = 'rolling';
  r.allowed = [];
  r.updatedAt = now;
  return r;
}

function stackSnapshot(r) {
  return r.order.reduce((a, u) => ({ ...a, [u]: r.players[u].stack }), {});
}

function finishRound(r, { winner, reason }, stakeOptions, now) {
  const loser = otherOf(r, winner);
  const amount = Math.min(r.stake, r.players[loser].stack);
  r.players[winner].stack += amount;
  r.players[loser].stack -= amount;
  const sums = {};
  for (const u of r.order) {
    const roll = r.cur.rolls[u];
    sums[u] = roll ? (roll.out ? 'out' : roll.sum) : null;
  }
  const entry = { n: r.round, winner, loser, stake: amount, reason, ties: r.cur.ties, sums, at: now };
  r.history = [entry, ...r.history].slice(0, HISTORY_CAP);
  r.last = entry;
  r.cur.queue = [];
  r.cur.done = true;
  if (r.players[loser].stack <= 0) {
    r.status = 'finished';
    r.phase = 'over';
    r.allowed = [];
    r.result = { winnerUid: winner, reason: 'bankrupt', stacks: stackSnapshot(r) };
  } else {
    r.phase = 'stake';
    r.allowed = allowedStakes(r, stakeOptions);
  }
}

function roll(room, uid, dice, stakeOptions, now) {
  if (room.status !== 'playing' || room.phase !== 'rolling') throw new GameError('failed-precondition', 'No round is being played.');
  const r = clone(room);
  const { cur, result } = applyRoll(r.cur, uid, dice[0], dice[1]);
  r.cur = cur;
  r.updatedAt = now;
  if (result) finishRound(r, result, stakeOptions, now);
  return r;
}

/** In practice rooms the COM player rolls instantly whenever it is its turn. */
function autoPlay(room, stakeOptions, now, rng = randomDie) {
  let r = room;
  for (let guard = 0; guard < 20; guard++) {
    if (r.mode !== 'ai' || r.status !== 'playing' || r.phase !== 'rolling' || r.cur.queue[0] !== AI_UID) break;
    r = roll(r, AI_UID, [rng(), rng()], stakeOptions, now);
  }
  return r;
}

function endRoom(r, result, now) {
  r.status = 'finished';
  r.phase = 'over';
  r.allowed = [];
  r.result = result;
  r.updatedAt = now;
}

/** Host cancels, or the system cancels an empty or abandoned room. Everyone gets their entry back. */
function cancel(room, now) {
  if (room.status === 'finished') throw new GameError('failed-precondition', 'This room has already ended.');
  const r = clone(room);
  endRoom(r, { winnerUid: null, reason: 'cancelled', stacks: stackSnapshot(r) }, now);
  return r;
}

/** A player gives up (or times out). Before any round is played everyone is simply refunded. */
function forfeit(room, uid, now, reason = 'forfeit') {
  if (room.status !== 'playing') throw new GameError('failed-precondition', 'There is no game to leave.');
  if (!room.playerUids.includes(uid)) throw new GameError('permission-denied', 'You are not in this room.');
  const r = clone(room);
  if (r.mode === 'ai') {
    endRoom(r, { winnerUid: AI_UID, reason, stacks: stackSnapshot(r) }, now);
    return r;
  }
  if (r.round === 0 && r.phase === 'stake') {
    endRoom(r, { winnerUid: null, reason: 'cancelled', stacks: stackSnapshot(r) }, now);
    return r;
  }
  const winner = otherOf(r, uid);
  r.players[winner].stack += r.players[uid].stack;
  r.players[uid].stack = 0;
  endRoom(r, { winnerUid: winner, reason, stacks: stackSnapshot(r) }, now);
  return r;
}

/** What to do with a room nobody is touching. Returns the new room state. */
function timeout(room, now) {
  if (room.status === 'waiting') return cancel(room, now);
  if (room.mode === 'ai') return forfeit(room, room.hostUid, now, 'timeout');
  const responsible = room.phase === 'stake' ? room.hostUid : room.cur.queue[0];
  return forfeit(room, responsible, now, 'timeout');
}

// ---------------------------------------------------------------- payouts
/**
 * Turn final stacks into wallet payouts. Total always balances:
 * sum(payouts) + rake === sum(stacks).
 */
function computePayouts(room, rakePercent) {
  if (room.mode !== 'pvp') return { payouts: {}, rake: 0 };
  const { stacks, reason } = room.result;
  const payouts = {};
  let rake = 0;
  for (const uid of room.playerUids) {
    let amount = stacks[uid] || 0;
    if (reason !== 'cancelled' && amount > room.entryFee) {
      const fee = Math.floor(((amount - room.entryFee) * rakePercent) / 100);
      rake += fee;
      amount -= fee;
    }
    payouts[uid] = amount;
  }
  return { payouts, rake };
}

export {
  AI_UID, GameError, randomDie, allowedStakes, newRound, applyRoll,
  newRoom, joinRoom, startRound, roll, autoPlay, cancel, forfeit, timeout, computePayouts,
};
