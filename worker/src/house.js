/**
 * The house account: where the room fees, the computer-table results and any rake end up.
 * It is the wallet document users/house (see wallet.js). Everything here is admin-only
 * (ADMIN_KEY) and can only be reached through /api/admin/house*.
 *
 * Safety rules for taking money out:
 *   - the destination is ALWAYS the OWNER_PHONE setting. It is never taken from the request, so
 *     a stolen admin key cannot send house money to someone else's number;
 *   - the amount is checked against the house balance inside a transaction;
 *   - the payout then goes through the same send-once pipeline as player withdrawals
 *     (pending -> sending -> processing -> success/failed, with "review" when unsure).
 */
import { db } from './fb.js';
import { fail } from './errors.js';
import { cfg } from './config.js';
import * as fapshi from './fapshi.js';
import { normalizeCM, operatorHint } from './phone.js';
import { readUsers, credit, flush, HOUSE_UID } from './wallet.js';
import { sendWithdrawal } from './payments.js';

const pay = () => db.collection('payments');

async function houseInfo() {
  const ref = db.collection('users').doc(HOUSE_UID);
  const [snap, recent] = await Promise.all([
    ref.get(),
    ref.collection('transactions').orderBy('createdAt', 'desc').limit(40).get(),
  ]);
  const h = snap.exists ? snap.data() : { balance: 0, stats: {} };
  const stats = h.stats || {};
  return {
    balance: h.balance || 0,
    roomFees: stats.roomFees || 0,
    comNet: stats.comNet || 0,
    rake: stats.rake || 0,
    ownerPhone: normalizeCM(cfg.OWNER_PHONE) || null,
    payoutsReady: fapshi.payoutConfigured(),
    minWithdraw: cfg.MIN_WITHDRAW,
    maxWithdraw: cfg.MAX_WITHDRAW,
    recent: recent.docs.map((d) => d.data()),
  };
}

/** Move house money to the owner's mobile money number. */
async function houseWithdraw(data, now = Date.now()) {
  const amount = Number(data.amount);
  if (!Number.isInteger(amount) || amount < cfg.MIN_WITHDRAW || amount > cfg.MAX_WITHDRAW) {
    throw fail('invalid-argument', `Enter a whole amount between ${cfg.MIN_WITHDRAW} and ${cfg.MAX_WITHDRAW} XAF.`);
  }
  const phone = normalizeCM(cfg.OWNER_PHONE);
  if (!phone) throw fail('failed-precondition', 'Set the OWNER_PHONE setting (your own mobile money number, like 670000000) in the worker, then try again.');
  const provider = operatorHint(phone);
  if (!provider) throw fail('failed-precondition', 'OWNER_PHONE must be an MTN or Orange number.');

  const ref = pay().doc();
  await db.runTransaction(async (tx) => {
    const users = await readUsers(tx, [HOUSE_UID]);
    const house = users[HOUSE_UID];
    if ((house.data.balance || 0) < amount) throw fail('failed-precondition', `The house only has ${house.data.balance || 0} XAF.`);
    credit(tx, house, -amount, 'withdraw_hold', ref.id, now, 'owner');
    flush(tx, users, now);
    tx.set(ref, { uid: HOUSE_UID, type: 'withdrawal', provider, amount, fee: 0, net: amount, phone, status: 'pending', createdAt: now, updatedAt: now });
  });

  let status = 'pending';
  if (fapshi.payoutConfigured()) {
    try {
      status = (await sendWithdrawal(ref.id)).status;
    } catch (e) {
      status = (await ref.get()).data().status; // pending or review; it stays in the admin list
    }
  }
  return { paymentId: ref.id, status, amount, phone };
}

/**
 * Add money to the house bankroll. ONLY do this after you have really put the same money into your
 * Fapshi balance, otherwise the house would owe players money it does not have.
 */
async function houseTopUp(data, now = Date.now()) {
  const amount = Number(data.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 5000000) throw fail('invalid-argument', 'Enter a whole amount in XAF.');
  const note = String(data.note || '').slice(0, 80) || 'bankroll';
  await db.runTransaction(async (tx) => {
    const users = await readUsers(tx, [HOUSE_UID]);
    credit(tx, users[HOUSE_UID], amount, 'house_topup', null, now, note);
    flush(tx, users, now);
  });
  return { ok: true };
}

export { houseInfo, houseWithdraw, houseTopUp };
