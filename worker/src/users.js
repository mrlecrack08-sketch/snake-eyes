import { db } from './fb.js';
import { fail } from './errors.js';
import { cfg } from './config.js';
import { randomInt } from './util.js';
import { readPartnerCode, attributionFields, writeRef } from './attrib.js';

/** Bump when the server gains something the pages depend on. /api/health and getConfig report it. */
export const SERVER_VERSION = 4;

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const NAME_RE = /^[\p{L}\p{N} ._-]{2,20}$/u;

export function randomCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export const cleanCode = (c) => (typeof c === 'string' ? c.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

/** The account id is the phone number, so one number can only ever have one account. */
export const uidFromPhone = (e164) => 'u' + String(e164).replace(/^\+/, '');

/** Validate the sign-up form fields (everything except the PIN, see auth.js). */
export function checkProfileInput(data) {
  const name = String(data.displayName || '').trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(name)) throw fail('invalid-argument', 'Choose a name of 2 to 20 letters or digits.');
  if (data.adult !== true) throw fail('failed-precondition', 'You must confirm that you are 18 or older.');
  return name;
}

/**
 * Create the profile document inside a transaction. `tx` has already read nothing; this function
 * does its own reads first, then returns a function that performs the writes.
 */
export async function planProfile(tx, { uid, phone, name, referralCode, extra }, now) {
  const ref = db.collection('users').doc(uid);
  const snap = await tx.get(ref);
  if (snap.exists) throw fail('already-exists', 'This number already has an account. Sign in instead.');

  let referredBy = null;
  let partner = null; // a partner's promo code, typed in the same box as a friend's referral code
  const given = cleanCode(referralCode);
  if (given) {
    partner = await readPartnerCode(tx, given);
    if (partner && !partner.active) throw fail('not-found', 'That code is no longer active.');
    if (!partner) {
      const refSnap = await tx.get(db.collection('referralCodes').doc(given));
      if (!refSnap.exists) throw fail('not-found', 'That referral code does not exist.');
      referredBy = refSnap.data().uid;
      if (referredBy === uid) throw fail('invalid-argument', 'You cannot use your own referral code.');
    }
  }

  let myCode = null;
  for (let i = 0; i < 8 && !myCode; i++) {
    const c = randomCode(6);
    const s = await tx.get(db.collection('referralCodes').doc(c));
    if (!s.exists) myCode = c;
  }
  if (!myCode) throw fail('unavailable', 'Please try again.');

  return () => {
    tx.set(db.collection('referralCodes').doc(myCode), { uid });
    const doc = {
      phone, displayName: name, balance: 0, unplayed: 0,
      referralCode: myCode, referredBy, referralRewarded: false,
      activeRoomId: null, stats: { played: 0, won: 0 }, knownPhones: [],
      adultConfirmedAt: now, createdAt: now, updatedAt: now,
    };
    if (partner) {
      Object.assign(doc, attributionFields(partner, 'signup', now));
      writeRef(tx, uid, doc, partner, 'signup', now);
    }
    if (extra) Object.assign(doc, extra);
    tx.set(ref, doc);
  };
}

export function publicConfig() {
  return {
    currency: cfg.CURRENCY,
    entryFee: cfg.ROOM_ENTRY_FEE,
    buyInOptions: cfg.BUY_IN_OPTIONS,
    roomFee: cfg.ROOM_FEE,
    version: SERVER_VERSION,
    features: ['house', 'promo', 'playthrough'], // lets the page know what this server can do
    stakeOptions: cfg.STAKE_OPTIONS,
    rakePercent: cfg.RAKE_PERCENT,
    minDeposit: cfg.MIN_DEPOSIT,
    maxDeposit: cfg.MAX_DEPOSIT,
    minWithdraw: cfg.MIN_WITHDRAW,
    maxWithdraw: cfg.MAX_WITHDRAW,
    withdrawFeePercent: cfg.WITHDRAW_FEE_PERCENT,
    referralBonus: cfg.REFERRAL_BONUS,
    referralMinDeposit: cfg.REFERRAL_MIN_DEPOSIT,
    idleTurnSeconds: cfg.IDLE_TURN_SECONDS,
    depositMode: cfg.FAPSHI.DEPOSIT_MODE,
    promo: {
      minDeposit: cfg.PROMO_MIN_DEPOSIT, maxDeposit: cfg.PROMO_MAX_DEPOSIT, bonus: cfg.PROMO_BONUS, wager: cfg.PROMO_WAGER,
    },
    playThroughPercent: cfg.PLAY_THROUGH,
  };
}
