/**
 * Phone number + 6-digit PIN accounts (no SMS).
 *
 *  - The account id is derived from the phone number.
 *  - The PIN is stored only as a salted PBKDF2 hash mixed with a server secret (PIN_PEPPER), in
 *    `userSecrets/{uid}`, which no browser can read.
 *  - 5 wrong PINs lock the account for 15 minutes. The counter lives in the database and is
 *    updated inside a transaction, so parallel guesses cannot dodge it.
 *  - After a correct PIN the server returns a Firebase custom token; the browser signs in with
 *    it, which is what lets it read its own wallet and room live.
 */
import { db } from './fb.js';
import { fail } from './errors.js';
import { cfg } from './config.js';
import { normalizeCM } from './phone.js';
import { b64url, safeEqual } from './util.js';
import { checkProfileInput, planProfile, uidFromPhone } from './users.js';

const enc = new TextEncoder();
const secrets = () => db.collection('userSecrets');

const WEAK = new Set(['123456', '654321', '012345', '123123', '121212', '112233', '000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999', '123321', '102030']);

export function checkPinFormat(pin) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) throw fail('invalid-argument', 'Your PIN must be exactly 6 digits.');
  if (WEAK.has(pin)) throw fail('invalid-argument', 'That PIN is too easy to guess. Choose another one.');
  return pin;
}

export async function hashPin(pin, salt, iterations = cfg.PIN_ITERATIONS) {
  if (!cfg.PIN_PEPPER || cfg.PIN_PEPPER.length < 16) throw new Error('PIN_PEPPER is not set (or too short). See the README.');
  const key = await crypto.subtle.importKey('raw', enc.encode(`${pin}:${cfg.PIN_PEPPER}`), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256);
  return b64url(bits);
}

const newSalt = () => b64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));

async function pinRecord(pin) {
  const salt = newSalt();
  const iter = cfg.PIN_ITERATIONS;
  return { hash: await hashPin(pin, salt, iter), salt, iter, failed: 0, lockedUntil: 0 };
}

const minutesLeft = (until, now) => Math.max(1, Math.ceil((until - now) / 60000));

/**
 * Check a PIN for an existing account and count failures. Throws a client-safe error on
 * failure. Used by sign-in, withdrawals and PIN change.
 */
export async function verifyPin(uid, pin, now = Date.now()) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) throw fail('invalid-argument', 'Enter your 6-digit PIN.');
  const ref = secrets().doc(uid);
  const out = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return { ok: false, reason: 'unknown' };
    const rec = s.data();
    if (rec.lockedUntil && rec.lockedUntil > now) return { ok: false, reason: 'locked', until: rec.lockedUntil };
    const hash = await hashPin(pin, rec.salt, rec.iter);
    if (safeEqual(hash, rec.hash)) {
      if (rec.failed || rec.lockedUntil) tx.update(ref, { failed: 0, lockedUntil: 0 });
      return { ok: true };
    }
    const failed = (rec.failed || 0) + 1;
    if (failed >= cfg.PIN_MAX_FAILURES) {
      const until = now + cfg.PIN_LOCK_MINUTES * 60000;
      tx.update(ref, { failed: 0, lockedUntil: until });
      return { ok: false, reason: 'locked', until };
    }
    tx.update(ref, { failed });
    return { ok: false, reason: 'wrong', left: cfg.PIN_MAX_FAILURES - failed };
  });
  if (out.ok) return true;
  if (out.reason === 'locked') {
    throw fail('resource-exhausted', `Too many wrong PINs. Try again in ${minutesLeft(out.until, now)} minute(s).`);
  }
  if (out.reason === 'wrong') throw fail('permission-denied', `Wrong number or PIN. ${out.left} ${out.left === 1 ? 'try' : 'tries'} left.`);
  throw fail('permission-denied', 'Wrong number or PIN.');
}

function readPhone(data) {
  const phone = normalizeCM(String(data.phone || ''));
  if (!phone) throw fail('invalid-argument', 'Enter a Cameroon mobile number, for example 6 70 00 00 00.');
  return phone;
}

/** Create an account. Returns who it is; the caller mints the sign-in token. */
export async function register(data, now = Date.now()) {
  const phone = readPhone(data);
  const name = checkProfileInput(data);
  const pin = checkPinFormat(data.pin);
  const uid = uidFromPhone(phone);
  const rec = await pinRecord(pin);

  await db.runTransaction(async (tx) => {
    const write = await planProfile(tx, { uid, phone, name, referralCode: data.referralCode }, now);
    write();
    tx.set(secrets().doc(uid), { ...rec, createdAt: now, updatedAt: now });
  });
  return { uid, phone };
}

/** Sign in with phone + PIN. */
export async function login(data, now = Date.now()) {
  const phone = readPhone(data);
  const uid = uidFromPhone(phone);
  await verifyPin(uid, data.pin, now);
  return { uid, phone };
}

export async function changePin(uid, data, now = Date.now()) {
  const next = checkPinFormat(data.newPin);
  await verifyPin(uid, data.pin, now);
  const rec = await pinRecord(next);
  await secrets().doc(uid).update({ ...rec, updatedAt: now });
  return { ok: true };
}

/** Admin tool for a player who forgot their PIN. The admin must confirm who they are first. */
export async function adminResetPin(data, now = Date.now()) {
  const phone = readPhone(data);
  const next = checkPinFormat(data.newPin);
  const uid = uidFromPhone(phone);
  const user = await db.collection('users').doc(uid).get();
  if (!user.exists) throw fail('not-found', 'No account has that number.');
  const rec = await pinRecord(next);
  await secrets().doc(uid).set({ ...rec, createdAt: now, updatedAt: now });
  return { ok: true, phone, name: user.data().displayName };
}
