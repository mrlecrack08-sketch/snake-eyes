/**
 * Room operations. Every operation is one Firestore transaction that:
 *   1. reads the room and the players' wallets,
 *   2. asks the pure engine for the next state,
 *   3. if the room just ended, pays everyone out and frees them,
 *   4. writes everything together.
 * Clients can never write rooms or balances (see firestore.rules).
 */
import { db } from './fb.js';
import { fail } from './errors.js';
import { cfg } from './config.js';
import * as E from './engine.js';
import { readUsers, credit, flush } from './wallet.js';
import { cleanCode, randomCode } from './users.js';

const rooms = () => db.collection('rooms');
const codes = () => db.collection('roomCodes');

async function findFreeCode(tx) {
  for (let i = 0; i < 8; i++) {
    const c = randomCode(5);
    const s = await tx.get(codes().doc(c));
    if (!s.exists) return c;
  }
  throw fail('unavailable', 'Please try again.');
}

/** A user who is still in an unfinished room cannot start or join another one. */
async function checkFree(tx, me) {
  const id = me.data.activeRoomId;
  if (!id) return;
  const snap = await tx.get(rooms().doc(id));
  if (snap.exists && snap.data().status !== 'finished') {
    throw fail('failed-precondition', 'Finish your current room first.', { roomId: id });
  }
  me.patch.activeRoomId = null; // stale pointer
  me.data.activeRoomId = null;
}

/** Pay out a room that has just finished. Idempotent through room.settled. */
function settle(tx, roomId, room, users, now) {
  if (room.settled) return;
  const { payouts, rake } = E.computePayouts(room, cfg.RAKE_PERCENT);
  room.result.payouts = payouts;
  room.result.rake = rake;
  for (const uid of room.playerUids) {
    const u = users[uid];
    if (!u || !u.exists) continue;
    if (room.mode === 'pvp') {
      const amount = payouts[uid] || 0;
      const type = room.result.reason === 'cancelled' ? 'room_refund' : 'room_payout';
      if (amount > 0) credit(tx, u, amount, type, roomId, now);
      if (room.result.reason !== 'cancelled') {
        const stats = u.data.stats || { played: 0, won: 0 };
        u.patch.stats = { played: stats.played + 1, won: stats.won + (room.result.winnerUid === uid ? 1 : 0) };
        u.data.stats = u.patch.stats;
      }
    }
    if (u.data.activeRoomId === roomId) {
      u.patch.activeRoomId = null;
      u.data.activeRoomId = null;
    }
  }
  if (room.code) tx.delete(codes().doc(room.code));
  room.settled = true;
}

/** Load a room plus the wallets of its human players. */
async function load(tx, roomId) {
  const roomRef = rooms().doc(roomId);
  const snap = await tx.get(roomRef);
  if (!snap.exists) throw fail('not-found', 'Room not found.');
  const room = snap.data();
  const users = await readUsers(tx, room.playerUids);
  return { roomRef, room, users };
}

function save(tx, roomRef, room, users, now) {
  if (room.status === 'finished') settle(tx, roomRef.id, room, users, now);
  flush(tx, users, now);
  tx.set(roomRef, room);
}

function mustBePlayer(room, uid) {
  if (!room.playerUids.includes(uid)) throw fail('permission-denied', 'You are not in this room.');
}

// ---------------------------------------------------------------- operations
async function createRoom(uid, data, now = Date.now()) {
  const mode = data.mode === 'ai' ? 'ai' : 'pvp';
  const visibility = data.visibility === 'public' ? 'public' : 'private';
  const fee = cfg.ROOM_ENTRY_FEE;

  return db.runTransaction(async (tx) => {
    const users = await readUsers(tx, [uid]);
    const me = users[uid];
    if (!me.exists) throw fail('failed-precondition', 'Create your profile first.');
    await checkFree(tx, me);
    const code = mode === 'pvp' ? await findFreeCode(tx) : null;
    if (mode === 'pvp' && (me.data.balance || 0) < fee) {
      throw fail('failed-precondition', `You need ${fee} XAF to enter a room. Add money first.`);
    }

    const roomRef = rooms().doc();
    const room = E.newRoom({ code, mode, visibility, hostUid: uid, hostName: me.data.displayName, entryFee: fee, stakeOptions: cfg.STAKE_OPTIONS, now });
    if (mode === 'pvp') {
      credit(tx, me, -fee, 'room_entry', roomRef.id, now);
      tx.set(codes().doc(code), { roomId: roomRef.id });
    }
    me.patch.activeRoomId = roomRef.id;
    me.data.activeRoomId = roomRef.id;
    flush(tx, users, now);
    tx.set(roomRef, room);
    return { roomId: roomRef.id, code };
  });
}

async function joinRoom(uid, data, now = Date.now()) {
  const fee = cfg.ROOM_ENTRY_FEE;
  return db.runTransaction(async (tx) => {
    let roomId = typeof data.roomId === 'string' ? data.roomId : null;
    if (!roomId) {
      const c = cleanCode(data.code);
      if (c.length < 4) throw fail('invalid-argument', 'Enter the room code.');
      const cs = await tx.get(codes().doc(c));
      if (!cs.exists) throw fail('not-found', 'No open room has that code.');
      roomId = cs.data().roomId;
    }
    const roomRef = rooms().doc(roomId);
    const [snap, users] = await Promise.all([tx.get(roomRef), readUsers(tx, [uid])]);
    if (!snap.exists) throw fail('not-found', 'Room not found.');
    const room = snap.data();
    const me = users[uid];
    if (!me.exists) throw fail('failed-precondition', 'Create your profile first.');
    if (room.status !== 'waiting') throw fail('failed-precondition', 'This room is no longer open.');
    if (room.hostUid === uid) throw fail('failed-precondition', 'This is your own room. Share the code with a friend.');
    await checkFree(tx, me);
    if ((me.data.balance || 0) < room.entryFee) {
      throw fail('failed-precondition', `You need ${room.entryFee} XAF to join. Add money first.`);
    }

    const next = E.joinRoom(room, uid, me.data.displayName, cfg.STAKE_OPTIONS, now);
    credit(tx, me, -room.entryFee, 'room_entry', roomId, now);
    me.patch.activeRoomId = roomId;
    me.data.activeRoomId = roomId;
    flush(tx, users, now);
    tx.set(roomRef, next);
    return { roomId };
  });
}

async function cancelRoom(uid, data, now = Date.now()) {
  return db.runTransaction(async (tx) => {
    const { roomRef, room, users } = await load(tx, String(data.roomId || ''));
    if (room.status !== 'waiting') throw fail('failed-precondition', 'Only a room that is still waiting can be cancelled.');
    if (room.hostUid !== uid) throw fail('permission-denied', 'Only the host can cancel.');
    save(tx, roomRef, E.cancel(room, now), users, now);
    return { ok: true };
  });
}

async function startRound(uid, data, now = Date.now()) {
  return db.runTransaction(async (tx) => {
    const { roomRef, room, users } = await load(tx, String(data.roomId || ''));
    mustBePlayer(room, uid);
    let next = E.startRound(room, uid, Number(data.stake), now);
    next = E.autoPlay(next, cfg.STAKE_OPTIONS, now);
    save(tx, roomRef, next, users, now);
    return { ok: true };
  });
}

async function rollDice(uid, data, now = Date.now(), rng = E.randomDie) {
  return db.runTransaction(async (tx) => {
    const { roomRef, room, users } = await load(tx, String(data.roomId || ''));
    mustBePlayer(room, uid);
    let next = E.roll(room, uid, [rng(), rng()], cfg.STAKE_OPTIONS, now);
    next = E.autoPlay(next, cfg.STAKE_OPTIONS, now);
    save(tx, roomRef, next, users, now);
    return { ok: true };
  });
}

async function forfeitRoom(uid, data, now = Date.now()) {
  return db.runTransaction(async (tx) => {
    const { roomRef, room, users } = await load(tx, String(data.roomId || ''));
    mustBePlayer(room, uid);
    const next = room.status === 'waiting' ? E.cancel(room, now) : E.forfeit(room, uid, now);
    save(tx, roomRef, next, users, now);
    return { ok: true, result: next.result.reason };
  });
}

// ---------------------------------------------------------------- housekeeping
/** Cancel abandoned waiting rooms and make idle players forfeit. Run on a schedule. */
async function sweepRooms(now = Date.now(), max = cfg.SWEEP_BATCH) {
  const out = { cancelled: 0, timedOut: 0, errors: 0 };
  const waitCut = now - cfg.WAITING_ROOM_SECONDS * 1000;
  const idleCut = now - Math.min(cfg.IDLE_TURN_SECONDS, cfg.PRACTICE_IDLE_SECONDS) * 1000;

  const stale = [];
  const w = await rooms().where('status', '==', 'waiting').where('updatedAt', '<', waitCut).limit(100).get();
  w.docs.forEach((d) => stale.push(d.id));
  const p = await rooms().where('status', '==', 'playing').where('updatedAt', '<', idleCut).limit(100).get();
  p.docs.forEach((d) => stale.push(d.id));

  for (const roomId of stale.slice(0, max)) {
    try {
      await db.runTransaction(async (tx) => {
        const { roomRef, room, users } = await load(tx, roomId);
        let limit;
        if (room.status === 'waiting') limit = cfg.WAITING_ROOM_SECONDS;
        else if (room.status === 'playing') limit = room.mode === 'ai' ? cfg.PRACTICE_IDLE_SECONDS : cfg.IDLE_TURN_SECONDS;
        else return;
        if (now - room.updatedAt < limit * 1000) return; // someone acted in the meantime
        const next = E.timeout(room, now);
        save(tx, roomRef, next, users, now);
        if (room.status === 'waiting') out.cancelled++; else out.timedOut++;
      });
    } catch (e) {
      out.errors++;
      console.error('sweep failed for room', roomId, e);
    }
  }
  return out;
}

export { createRoom, joinRoom, cancelRoom, startRound, rollDice, forfeitRoom, sweepRooms };
