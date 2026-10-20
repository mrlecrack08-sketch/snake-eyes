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

async function readUsers(tx, uids) {
  const unique = [...new Set(uids)];
  const snaps = await Promise.all(unique.map((u) => tx.get(userRef(u))));
  const out = {};
  unique.forEach((u, i) => {
    out[u] = { uid: u, ref: userRef(u), exists: snaps[i].exists, data: snaps[i].exists ? { ...snaps[i].data() } : null, patch: {} };
  });
  return out;
}

/** Add (or subtract) money. `delta` is a signed integer. Throws if the balance would go negative. */
function credit(tx, entry, delta, type, refId, now, note) {
  if (!entry.exists) throw fail('failed-precondition', 'Account not found.');
  if (!Number.isInteger(delta)) throw new Error('Non-integer amount ' + delta);
  const next = (entry.data.balance || 0) + delta;
  if (next < 0) throw fail('failed-precondition', 'Your balance is too low.');
  entry.data.balance = next;
  entry.patch.balance = next;
  tx.set(entry.ref.collection('transactions').doc(), {
    type, amount: delta, balanceAfter: next, ref: refId || null, note: note || null, createdAt: now,
  });
}

/** Write the accumulated changes for every loaded user. */
function flush(tx, users, now) {
  for (const u of Object.values(users)) {
    if (u.exists && Object.keys(u.patch).length) tx.update(u.ref, { ...u.patch, updatedAt: now });
  }
}

export { userRef, readUsers, credit, flush };
