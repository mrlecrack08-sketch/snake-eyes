/**
 * Two money rules that sit on top of the wallet:
 *
 * 1. PLAY-THROUGH. Money a player deposits can only be withdrawn after it has been bet.
 *    `user.unplayed` is the part of the wallet that still has to be bet. Winnings are free to leave;
 *    the withdrawable amount is `balance - unplayed`.
 *
 * 2. PROMO BONUS. A partner's promo code puts the deposit plus a bonus into a separate section,
 *    `user.promo = { balance, wagerLeft, ... }`. It never shows in the normal balance. It can only be
 *    played against the computer ("house" rooms). Once PROMO_WAGER XAF have been bet with it, what is
 *    left moves to the normal balance and can be withdrawn. If it is all lost first, the promo ends.
 *
 * Everything here runs inside the caller's Firestore transaction on already-read wallet entries.
 */
import { cfg } from './config.js';
import { credit, bumpStat } from './wallet.js';

const clampInt = (n) => Math.max(0, Math.floor(Number(n) || 0));

// ---------------------------------------------------------------- play-through
export const unplayedOf = (data) => Math.min(clampInt(data.unplayed), clampInt(data.balance));
export const withdrawableOf = (data) => Math.max(0, clampInt(data.balance) - clampInt(data.unplayed));

/** Money just deposited must be bet before it can leave. */
export function addUnplayed(entry, amount) {
  if (!cfg.PLAY_THROUGH || entry.data.demo) return;
  const next = clampInt(entry.data.unplayed) + Math.floor((amount * cfg.PLAY_THROUGH) / 100);
  entry.data.unplayed = next;
  entry.patch.unplayed = next;
}

/** A finished room: `bet` XAF changed hands, so that much of the deposit counts as played. */
export function recordPlay(entry, bet) {
  if (!entry.exists || entry.data.demo) return;
  const next = Math.min(Math.max(0, clampInt(entry.data.unplayed) - clampInt(bet)), clampInt(entry.data.balance));
  if (next !== clampInt(entry.data.unplayed)) {
    entry.data.unplayed = next;
    entry.patch.unplayed = next;
  }
}

// ---------------------------------------------------------------- promo section
export const promoOf = (data) => (data.promo && typeof data.promo === 'object' ? data.promo : null);

/** Move money in the promo section and write a ledger line marked section 'promo'. */
export function promoMove(tx, entry, delta, type, refId, now, note) {
  const p = { ...(promoOf(entry.data) || { balance: 0, wagerLeft: 0 }) };
  const next = clampInt(p.balance) + delta;
  if (next < 0) throw new Error('Promo balance would go negative');
  p.balance = next;
  entry.data.promo = p;
  entry.patch.promo = p;
  tx.set(entry.ref.collection('transactions').doc(), {
    type, amount: delta, balanceAfter: next, ref: refId || null, note: note || null, section: 'promo', createdAt: now,
  });
}

/**
 * A promo deposit has been paid. The deposit and the bonus go into the promo section. The bonus is a
 * cost, so the house pays it (the house balance may go below zero: it is the owner's equity).
 */
export function grantPromo(tx, me, house, { value, code, partnerId, partnerName }, paymentId, now) {
  const bonus = cfg.PROMO_BONUS;
  me.data.promo = { balance: 0, wagerLeft: cfg.PROMO_WAGER, deposit: value, bonus, code, partnerId, grantedAt: now };
  me.patch.promo = me.data.promo;
  me.patch.promoUsedAt = now;
  me.patch.promoStatus = 'active';
  promoMove(tx, me, value, 'promo_deposit', paymentId, now, code);
  if (bonus > 0) {
    promoMove(tx, me, bonus, 'promo_bonus', paymentId, now, code);
    if (house) {
      credit(tx, house, -bonus, 'promo_cost', paymentId, now, partnerName || code, true);
      bumpStat(house, 'promoBonus', bonus);
    }
  }
}

/**
 * A room funded with promo money has finished. `payout` goes back into the promo section, the bet
 * counts toward the wager, and when the wager is done the remaining promo money becomes normal money.
 * Returns what happened, for the caller's notes: 'unlocked' | 'lost' | null.
 */
export function settlePromoRoom(tx, u, { payout, bet, cancelled }, roomId, now) {
  const promo = promoOf(u.data);
  if (!promo) { // should not happen; do not lose the player's money
    if (payout > 0) credit(tx, u, payout, 'room_payout', roomId, now);
    return null;
  }
  if (payout > 0) promoMove(tx, u, payout, cancelled ? 'room_refund' : 'room_payout', roomId, now);
  const wagerLeft = cancelled ? clampInt(promo.wagerLeft) : Math.max(0, clampInt(promo.wagerLeft) - clampInt(bet));
  const p = { ...promoOf(u.data), wagerLeft };
  u.data.promo = p;
  u.patch.promo = p;

  const balance = clampInt(p.balance);
  if (wagerLeft <= 0) {
    if (balance > 0) {
      promoMove(tx, u, -balance, 'promo_unlock', roomId, now);
      credit(tx, u, balance, 'promo_unlock', roomId, now);
    }
    closePromo(u, 'unlocked', now);
    return 'unlocked';
  }
  if (balance <= 0) {
    closePromo(u, 'lost', now);
    return 'lost';
  }
  return null;
}

function closePromo(u, status, now) {
  u.data.promo = null;
  u.patch.promo = null;
  u.data.promoStatus = status;
  u.patch.promoStatus = status;
  u.patch.promoClosedAt = now;
}
