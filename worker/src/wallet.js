/**
 * Wallet helpers used inside Firestore transactions.
 * Balances are whole XAF integers and ONLY ever change here, on the server.
 * Every change writes a ledger line under users/{uid}/transactions.
 *
 * Firestore rule: all reads in a transaction must happen before any write. So callers first
 * `readUsers`, then call `credit` as often as needed, and finish with `flush`.
 */
import { db } from './fb.js';
import { fail } from './errors.js';

const userRef = (uid) => db.collection('users').doc(uid);

/**
 * The house account. It is an ordinary wallet document at users/house (a real player's id is always
 * 'u' + digits, so they can never collide). It receives the room fees, the computer-table results and
 * any rake, and it is the only account the owner can withdraw from (see house.js). It is created the
 * first time it is touched.
 */
const HOUSE_UID = 'house';

async function readUsers(tx, uids) {
  const unique = [...new Set(uids)];
  const snaps = await Promise.all(unique.map((u) => tx.get(userRef(u))));
  const out = {};
  unique.forEach((u, i) => {
    out[u] = { uid: u, ref: userRef(u), exists: snaps[i].exists, data: snaps[i].exists ? { ...snaps[i].data() } : null, patch: {} };
    if (u === HOUSE_UID && !snaps[i].exists) {
      out[u].exists = true;
      out[u].isNew = true;
      out[u].data = { displayName: 'House', isHouse: true, balance: 0, stats: { roomFees: 0, rake: 0, comNet: 0 } };
    }
  });
  return out;
}

/**
 * Add (or subtract) money. `delta` is a signed integer. Throws if the balance would go negative,
 * unless `allowNegative` is set (only used for the house, whose balance is the owner's equity: a
 * promo bonus or a partner commission is a cost that the house carries).
 */
function credit(tx, entry, delta, type, refId, now, note, allowNegative = false) {
  if (!entry.exists) throw fail('failed-precondition', 'Account not found.');
  if (!Number.isInteger(delta)) throw new Error('Non-integer amount ' + delta);
  const next = (entry.data.balance || 0) + delta;
  if (next < 0 && !allowNegative) throw fail('failed-precondition', 'Your balance is too low.');
  entry.data.balance = next;
  entry.patch.balance = next;
  tx.set(entry.ref.collection('transactions').doc(), {
    type, amount: delta, balanceAfter: next, ref: refId || null, note: note || null, createdAt: now,
  });
}

/** Write the accumulated changes for every loaded user. */
function flush(tx, users, now) {
  for (const u of Object.values(users)) {
    if (!u.exists) continue;
    if (u.isNew) tx.set(u.ref, { ...u.data, ...u.patch, createdAt: now, updatedAt: now });
    else if (Object.keys(u.patch).length) tx.update(u.ref, { ...u.patch, updatedAt: now });
  }
}

/** Add to one of the house's running totals (roomFees, rake, comNet). Totals can go negative (comNet). */
function bumpStat(entry, key, delta) {
  const stats = { ...(entry.data.stats || {}) };
  stats[key] = (stats[key] || 0) + delta;
  entry.data.stats = stats;
  entry.patch.stats = stats;
}

export { userRef, readUsers, credit, flush, bumpStat, HOUSE_UID };
