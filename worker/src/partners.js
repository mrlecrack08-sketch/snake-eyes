/**
 * Partners and demo accounts. Everything here except `promoCheck` is admin-only (ADMIN_KEY).
 *
 *   - A partner has a promo code. Players who join with it (at sign-up or on the promo page) are
 *     listed in /Crack under that partner. The partner earns PARTNER_PERCENT of each such player's
 *     FIRST real deposit (see finalizeDeposit in payments.js). The commission sits in the partner's
 *     wallet, users/p_{id}, until the owner pays it out to the partner's own mobile money number.
 *   - A demo account is a normal-looking account with fictitious money that the owner sets. It never
 *     touches real money (see rooms.js, payments.js).
 */
import { db } from './fb.js';
import { fail } from './errors.js';
import { cfg } from './config.js';
import * as fapshi from './fapshi.js';
import { normalizeCM, operatorHint } from './phone.js';
import { readUsers, credit, flush } from './wallet.js';
import { sendWithdrawal } from './payments.js';
import { adminCreateDemo } from './auth.js';
import { cleanPartnerCode, partnerWalletUid } from './attrib.js';
import { randomCode } from './users.js';

const partners = () => db.collection('partners');
const codesCol = () => db.collection('partnerCodes');
const pay = () => db.collection('payments');
const MAX_BALANCE = 10000000;

const cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ');

// ---------------------------------------------------------------- the player's side
/** Is this promo code real? Shown on the promo page before the player pays. */
export async function promoCheck(uid, data) {
  const code = cleanPartnerCode(data.code);
  if (code.length < 3) throw fail('invalid-argument', 'Enter the promo code.');
  const s = await codesCol().doc(code).get();
  if (!s.exists || s.data().active === false) throw fail('not-found', 'That promo code does not exist or is no longer active.');
  return { code, partnerName: s.data().name || code };
}

// ---------------------------------------------------------------- partners
function makeCode(name) {
  const base = cleanPartnerCode(name).slice(0, 6);
  return (base.length >= 3 ? base : 'SNK') + randomCode(2).replace(/[^A-Z]/g, 'X');
}

export async function partnerAdd(data, now = Date.now()) {
  const name = cleanName(data.name);
  if (name.length < 2 || name.length > 30) throw fail('invalid-argument', 'Enter the partner\'s name (2 to 30 characters).');
  const phone = normalizeCM(String(data.phone || ''));
  if (!phone || !operatorHint(phone)) throw fail('invalid-argument', 'Enter the partner\'s MTN or Orange mobile money number (this is where you will pay them).');
  const wanted = data.code ? cleanPartnerCode(data.code) : '';
  if (data.code && (wanted.length < 3 || wanted.length > 12)) throw fail('invalid-argument', 'The promo code must have 3 to 12 letters or digits.');
  const code = wanted || makeCode(name);
  const id = code.toLowerCase();
  const wallet = partnerWalletUid(id);

  await db.runTransaction(async (tx) => {
    const [taken, asReferral, asPartner] = await Promise.all([
      tx.get(codesCol().doc(code)), tx.get(db.collection('referralCodes').doc(code)), tx.get(partners().doc(id)),
    ]);
    if (taken.exists || asReferral.exists || asPartner.exists) throw fail('already-exists', `The code ${code} is already used. Choose another one.`);
    tx.set(partners().doc(id), { id, name, phone, code, active: true, createdAt: now, updatedAt: now });
    tx.set(codesCol().doc(code), { partnerId: id, name, active: true });
    tx.set(db.collection('users').doc(wallet), {
      displayName: name, isPartner: true, partnerId: id, balance: 0, stats: { commission: 0, depositsTotal: 0 },
      createdAt: now, updatedAt: now,
    });
  });

  let demo = null;
  if (data.demoPhone) {
    demo = await adminCreateDemo({ phone: data.demoPhone, name: data.demoName || name, pin: data.demoPin, balance: data.demoBalance || 0, partnerId: id }, now);
  }
  return { id, code, name, phone, demo };
}

export async function partnerSetActive(data, now = Date.now()) {
  const id = String(data.id || '');
  const active = data.active === true;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(partners().doc(id));
    if (!s.exists) throw fail('not-found', 'Partner not found.');
    tx.update(partners().doc(id), { active, updatedAt: now });
    tx.update(codesCol().doc(s.data().code), { active });
  });
  return { ok: true };
}

/** One table for /Crack: each partner with what they brought, earned and are still owed. */
export async function partnerList() {
  const [pSnap, refSnap] = await Promise.all([
    partners().orderBy('createdAt', 'asc').limit(200).get(),
    db.collection('partnerRefs').orderBy('joinedAt', 'desc').limit(1000).get(),
  ]);
  const counts = {};
  for (const d of refSnap.docs) {
    const r = d.data();
    const c = counts[r.partnerId] || (counts[r.partnerId] = { joined: 0, deposited: 0, depositTotal: 0 });
    c.joined++;
    if (r.firstDeposit) { c.deposited++; c.depositTotal += r.firstDeposit; }
  }
  const wallets = await Promise.all(pSnap.docs.map((d) => db.collection('users').doc(partnerWalletUid(d.id)).get()));
  const items = pSnap.docs.map((d, i) => {
    const p = d.data();
    const w = wallets[i].exists ? wallets[i].data() : { balance: 0, stats: {} };
    const earned = (w.stats && w.stats.commission) || 0;
    const owed = w.balance || 0;
    const c = counts[p.id] || { joined: 0, deposited: 0, depositTotal: 0 };
    return {
      id: p.id, name: p.name, phone: p.phone, code: p.code, active: p.active !== false, createdAt: p.createdAt,
      joined: c.joined, deposited: c.deposited, depositTotal: c.depositTotal,
      earned, owed, paid: Math.max(0, earned - owed),
    };
  });
  return { items, percent: cfg.PARTNER_PERCENT, minPayout: cfg.PARTNER_MIN_PAYOUT, payoutsReady: fapshi.payoutConfigured() };
}

/** The "new participants" table: who came in with which partner. */
export async function referralsList(data) {
  let q = db.collection('partnerRefs');
  if (data && typeof data.partnerId === 'string' && data.partnerId) q = q.where('partnerId', '==', data.partnerId);
  const snap = await q.limit(500).get();
  const items = snap.docs.map((d) => d.data()).sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));
  return { items };
}

/**
 * Pay a partner what they are owed, to the number saved for them (never a number from the request).
 * It goes through the same send-once payout pipeline as every other withdrawal.
 */
export async function partnerPay(data, now = Date.now()) {
  const id = String(data.id || '');
  const amount = Number(data.amount);
  if (!Number.isInteger(amount) || amount < cfg.PARTNER_MIN_PAYOUT || amount > cfg.MAX_WITHDRAW) {
    throw fail('invalid-argument', `Enter a whole amount between ${cfg.PARTNER_MIN_PAYOUT} and ${cfg.MAX_WITHDRAW} XAF.`);
  }
  const ps = await partners().doc(id).get();
  if (!ps.exists) throw fail('not-found', 'Partner not found.');
  const phone = normalizeCM(ps.data().phone);
  const provider = phone ? operatorHint(phone) : null;
  if (!provider) throw fail('failed-precondition', 'This partner has no valid MTN or Orange number.');
  const wallet = partnerWalletUid(id);

  const ref = pay().doc();
  await db.runTransaction(async (tx) => {
    const users = await readUsers(tx, [wallet]);
    const w = users[wallet];
    if (!w.exists) throw fail('not-found', 'Partner wallet not found.');
    if ((w.data.balance || 0) < amount) throw fail('failed-precondition', `${ps.data().name} is only owed ${w.data.balance || 0} XAF.`);
    credit(tx, w, -amount, 'withdraw_hold', ref.id, now, 'partner payout');
    flush(tx, users, now);
    tx.set(ref, { uid: wallet, type: 'withdrawal', provider, amount, fee: 0, net: amount, phone, status: 'pending', createdAt: now, updatedAt: now });
  });

  let status = 'pending';
  if (fapshi.payoutConfigured()) {
    try {
      status = (await sendWithdrawal(ref.id)).status;
    } catch (e) {
      status = (await ref.get()).data().status; // stays in the withdrawals list; retried automatically
    }
  }
  return { paymentId: ref.id, status, amount, phone };
}

// ---------------------------------------------------------------- demo accounts
export const demoCreate = (data) => adminCreateDemo(data);

export async function demoList() {
  const snap = await db.collection('users').where('demo', '==', true).limit(200).get();
  const items = snap.docs.map((d) => {
    const u = d.data();
    return { uid: d.id, name: u.displayName, phone: u.phone, balance: u.balance || 0, partnerId: u.demoOf || null, createdAt: u.createdAt || 0 };
  }).sort((a, b) => a.createdAt - b.createdAt);
  return { items };
}

/** Set a demo account's fictitious balance to an exact amount. */
export async function demoSetBalance(data, now = Date.now()) {
  const uid = String(data.uid || '');
  const target = Number(data.balance);
  if (!Number.isInteger(target) || target < 0 || target > MAX_BALANCE) throw fail('invalid-argument', 'Enter a whole amount of fictitious XAF, 0 or more.');
  return db.runTransaction(async (tx) => {
    const users = await readUsers(tx, [uid]);
    const u = users[uid];
    if (!u.exists || !u.data.demo) throw fail('failed-precondition', 'That is not a demo account.');
    const delta = target - (u.data.balance || 0);
    if (delta !== 0) credit(tx, u, delta, 'demo_adjust', null, now, 'set by owner');
    flush(tx, users, now);
    return { uid, balance: target };
  });
}
