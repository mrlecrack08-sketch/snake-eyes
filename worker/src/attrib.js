/**
 * Partner codes and who joined with which partner.
 *
 *   partners/{partnerId}        the partner (name, phone for payouts, code, active). Admin only.
 *   partnerCodes/{CODE}         { partnerId, name, active } so a code can be checked with one read.
 *   partnerRefs/{uid}           one row per player who came with a partner code (the /Crack table).
 *   users/p_{partnerId}         the partner's wallet: the commission they have earned and not yet been paid.
 *
 * A player is linked to ONE partner, the first one they use (at sign-up or on the promo page).
 */
import { db } from './fb.js';
import { fail } from './errors.js';

export const partnerWalletUid = (partnerId) => 'p_' + partnerId;
export const cleanPartnerCode = (c) => (typeof c === 'string' ? c.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

const codes = () => db.collection('partnerCodes');
const refs = () => db.collection('partnerRefs');

/** Read a partner code inside a transaction. Returns null if there is none. */
export async function readPartnerCode(tx, raw) {
  const code = cleanPartnerCode(raw);
  if (code.length < 3) return null;
  const s = await tx.get(codes().doc(code));
  if (!s.exists) return null;
  const d = s.data();
  return { code, partnerId: d.partnerId, partnerName: d.name || code, active: d.active !== false };
}

/** The fields a player document gets when they join with a partner code. */
export const attributionFields = (info, via, now) => ({
  partnerId: info.partnerId, partnerCode: info.code, partnerName: info.partnerName,
  partnerVia: via, partnerJoinedAt: now, partnerCommissionPaid: false,
});

/** The row in the partner table (/Crack) for one player. */
export const refRow = (uid, user, info, via, now) => ({
  uid, name: user.displayName || '', phone: user.phone || '',
  partnerId: info.partnerId, partnerName: info.partnerName, code: info.code,
  via, joinedAt: now, firstDeposit: null, commission: null, firstDepositAt: null, promoUsed: false,
});

export function writeRef(tx, uid, user, info, via, now) {
  tx.set(refs().doc(uid), refRow(uid, user, info, via, now));
}

/**
 * Link an existing player to the partner behind `code` (promo page). Safe to repeat for the same
 * partner; refuses a different partner. Returns the partner info.
 */
export async function attachPartner(uid, codeRaw, via, now = Date.now()) {
  return db.runTransaction(async (tx) => {
    const uref = db.collection('users').doc(uid);
    const us = await tx.get(uref);
    if (!us.exists) throw fail('failed-precondition', 'Account not found.');
    const user = us.data();
    const info = await readPartnerCode(tx, codeRaw);
    if (!info || !info.active) throw fail('not-found', 'That promo code does not exist or is no longer active.');
    if (user.partnerId) {
      if (user.partnerId !== info.partnerId) throw fail('failed-precondition', `You already joined with another code (${user.partnerCode}). Use that one.`);
      return info;
    }
    if (user.isHouse || user.isPartner || user.demo) throw fail('failed-precondition', 'This account cannot use a promo code.');
    tx.update(uref, { ...attributionFields(info, via, now), updatedAt: now });
    writeRef(tx, uid, user, info, via, now);
    return info;
  });
}
