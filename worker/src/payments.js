/**
 * Deposits, withdrawals, the Fapshi webhook and the admin tools.
 *
 * Safety rules this file follows:
 *  - A deposit is credited only after WE read SUCCESSFUL from Fapshi. A webhook body is only used
 *    to find out which payment to re-check.
 *  - Crediting is one transaction that also flips the payment out of 'pending', so a payment can
 *    never be credited twice, whatever order webhooks, polling and the cron job arrive in.
 *  - A withdrawal needs the PIN, takes the money out of the wallet first (hold), and goes only to
 *    your own number or one you have deposited from. If it is rejected or fails, the hold is refunded.
 *  - A payout is claimed (pending -> sending) before Fapshi is called, so it can never be sent twice.
 */
import { db } from './fb.js';
import { fail } from './errors.js';
import { cfg } from './config.js';
import * as fapshi from './fapshi.js';
import { normalizeCM, operatorHint } from './phone.js';
import { readUsers, credit, flush } from './wallet.js';
import { verifyPin } from './auth.js';
import { safeEqual } from './util.js';

const pay = () => db.collection('payments');
const PROVIDERS = ['mtn', 'orange'];
const ID_RE = /^[A-Za-z0-9]{20}$/;

function checkAmount(amount, min, max) {
  if (!Number.isInteger(amount) || amount < min || amount > max) {
    throw fail('invalid-argument', `Enter a whole amount between ${min} and ${max} XAF.`);
  }
}

async function loadUserDoc(uid) {
  const s = await db.collection('users').doc(uid).get();
  if (!s.exists) throw fail('failed-precondition', 'Account not found.');
  return s.data();
}

function pickProvider(given, phone) {
  const p = PROVIDERS.includes(given) ? given : operatorHint(phone);
  if (!p) throw fail('invalid-argument', 'Choose MTN MoMo or Orange Money.');
  return p;
}

// ---------------------------------------------------------------- deposits
async function startDeposit(uid, data, now = Date.now()) {
  const amount = Number(data.amount);
  checkAmount(amount, cfg.MIN_DEPOSIT, cfg.MAX_DEPOSIT);
  const user = await loadUserDoc(uid);
  const phone = normalizeCM(data.phone || user.phone);
  if (!phone) throw fail('invalid-argument', 'Enter a valid Cameroon mobile number.');
  const provider = pickProvider(data.provider, phone);

  const open = await pay().where('uid', '==', uid).where('status', '==', 'pending').limit(8).get();
  if (open.docs.filter((d) => d.data().type === 'deposit').length >= 5) {
    throw fail('resource-exhausted', 'You have several unfinished payments. Wait a few minutes and try again.');
  }

  const ref = pay().doc();
  await ref.set({ uid, type: 'deposit', provider, amount, phone, status: 'pending', createdAt: now, updatedAt: now });
  try {
    const r = await fapshi.requestDeposit({ paymentId: ref.id, amount, phone, provider, uid, name: user.displayName });
    await ref.update({ providerRef: r.providerRef || null, updatedAt: Date.now() });
    return { paymentId: ref.id, status: 'pending', payUrl: r.payUrl || null };
  } catch (e) {
    console.error('Deposit start failed:', e.message);
    await ref.update({ status: 'failed', error: String(e.message).slice(0, 300), updatedAt: Date.now() });
    throw fail('unavailable', 'The payment service could not start the payment. Please try again in a moment.');
  }
}

/**
 * Credit a successful deposit exactly once, and pay the referral bonus on a first qualifying
 * deposit. `from` lists the statuses it may be credited from; `amount` overrides the amount
 * (used when an admin settles a payment that was held for review).
 */
async function finalizeDeposit(paymentId, now = Date.now(), { from = ['pending'], amount } = {}) {
  return db.runTransaction(async (tx) => {
    const pRef = pay().doc(paymentId);
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists) return false;
    const p = pSnap.data();
    if (p.type !== 'deposit' || !from.includes(p.status)) return false;
    const value = amount === undefined ? p.amount : amount;

    const users = await readUsers(tx, [p.uid]);
    const me = users[p.uid];
    if (!me.exists) throw fail('failed-precondition', 'Account not found.');

    let referrerUid = null;
    if (cfg.REFERRAL_BONUS > 0 && me.data.referredBy && !me.data.referralRewarded && value >= cfg.REFERRAL_MIN_DEPOSIT) {
      referrerUid = me.data.referredBy;
      users[referrerUid] = (await readUsers(tx, [referrerUid]))[referrerUid];
    }

    tx.update(pRef, { status: 'success', creditedAmount: value, completedAt: now, updatedAt: now });
    credit(tx, me, value, 'deposit', paymentId, now, p.provider);
    // A phone number that has paid into this account is a number we know belongs to the player.
    const known = Array.isArray(me.data.knownPhones) ? me.data.knownPhones : [];
    if (!known.includes(p.phone)) me.patch.knownPhones = [...known, p.phone].slice(-5);
    if (referrerUid && users[referrerUid].exists) {
      credit(tx, users[referrerUid], cfg.REFERRAL_BONUS, 'referral_bonus', p.uid, now, me.data.displayName);
      me.patch.referralRewarded = true;
    }
    flush(tx, users, now);
    return true;
  });
}

async function setPaymentStatus(paymentId, from, status, extra = {}) {
  return db.runTransaction(async (tx) => {
    const ref = pay().doc(paymentId);
    const s = await tx.get(ref);
    if (!s.exists || !from.includes(s.data().status)) return false;
    tx.update(ref, { status, updatedAt: Date.now(), ...extra });
    return true;
  });
}

// ---------------------------------------------------------------- withdrawals
async function requestWithdrawal(uid, data, now = Date.now()) {
  const amount = Number(data.amount);
  checkAmount(amount, cfg.MIN_WITHDRAW, cfg.MAX_WITHDRAW);
  await verifyPin(uid, data.pin, now);
  const user = await loadUserDoc(uid);
  const phone = normalizeCM(data.phone || user.phone);
  if (!phone) throw fail('invalid-argument', 'Enter a valid Cameroon mobile number.');
  const allowed = new Set([user.phone, ...(Array.isArray(user.knownPhones) ? user.knownPhones : [])]);
  if (!allowed.has(phone)) {
    throw fail('permission-denied', 'For your security, money can only be sent to your own number or to a number you have already paid in from.');
  }
  const provider = pickProvider(data.provider, phone);
  const fee = Math.floor((amount * cfg.WITHDRAW_FEE_PERCENT) / 100);
  const net = amount - fee;

  const ref = pay().doc();
  await db.runTransaction(async (tx) => {
    const users = await readUsers(tx, [uid]);
    const me = users[uid];
    if (!me.exists) throw fail('failed-precondition', 'Account not found.');
    credit(tx, me, -amount, 'withdraw_hold', ref.id, now, provider);
    flush(tx, users, now);
    tx.set(ref, { uid, type: 'withdrawal', provider, amount, fee, net, phone, status: 'pending', createdAt: now, updatedAt: now });
  });

  let status = 'pending';
  if (cfg.AUTO_PAYOUT_MAX > 0 && net <= cfg.AUTO_PAYOUT_MAX && fapshi.payoutConfigured()) {
    try {
      status = (await sendWithdrawal(ref.id)).status;
    } catch (e) {
      console.error('Automatic payout did not go through, left for the admin:', e.message);
      status = (await ref.get()).data().status;
    }
  }
  return { paymentId: ref.id, status: status === 'sending' ? 'pending' : status, net, fee };
}

/** Send a withdrawal through Fapshi. The claim step makes sure this can only ever run once. */
async function sendWithdrawal(paymentId, now = Date.now()) {
  const claimed = await db.runTransaction(async (tx) => {
    const ref = pay().doc(paymentId);
    const s = await tx.get(ref);
    if (!s.exists) throw fail('not-found', 'Payment not found.');
    const p = s.data();
    if (p.type !== 'withdrawal') throw fail('failed-precondition', 'This is not a withdrawal.');
    if (p.status !== 'pending') return null;
    tx.update(ref, { status: 'sending', updatedAt: now });
    return p;
  });
  if (!claimed) throw fail('failed-precondition', 'This withdrawal is not waiting to be sent.');
  if (!fapshi.payoutConfigured()) {
    await setPaymentStatus(paymentId, ['sending'], 'pending', { note: 'Fapshi payout keys are not set.' });
    throw fail('failed-precondition', 'Fapshi payout keys are not set. Add them, or pay by hand and press Mark paid.');
  }
  try {
    const r = await fapshi.payout({ paymentId, amount: claimed.net, phone: claimed.phone, provider: claimed.provider, uid: claimed.uid });
    await pay().doc(paymentId).update({ status: 'processing', providerRef: r.providerRef, updatedAt: Date.now() });
    return { status: 'processing' };
  } catch (e) {
    if (e.definite) {
      await setPaymentStatus(paymentId, ['sending'], 'pending', { note: String(e.message).slice(0, 200) });
      throw fail('unavailable', e.message);
    }
    await setPaymentStatus(paymentId, ['sending'], 'review', { note: 'Payout outcome unknown. Check the Fapshi dashboard, then press Mark paid or Reject.' });
    throw fail('unavailable', 'The payout result is unknown. It was moved to Needs review. Check Fapshi before doing anything else.');
  }
}

/** Close a withdrawal. outcome: 'paid' keeps the money gone; 'rejected' or 'failed' gives it back. */
async function resolveWithdrawal(paymentId, outcome, { by = null, note = null, now = Date.now(), allowed = ['pending', 'processing', 'review'] } = {}) {
  return db.runTransaction(async (tx) => {
    const ref = pay().doc(paymentId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw fail('not-found', 'Payment not found.');
    const p = snap.data();
    if (p.type !== 'withdrawal') throw fail('failed-precondition', 'This is not a withdrawal.');
    if (!allowed.includes(p.status)) return { changed: false, status: p.status };

    if (outcome === 'paid') {
      tx.update(ref, { status: 'success', resolvedBy: by, note, completedAt: now, updatedAt: now });
      return { changed: true, status: 'success' };
    }
    const users = await readUsers(tx, [p.uid]);
    credit(tx, users[p.uid], p.amount, 'withdraw_refund', paymentId, now, outcome);
    flush(tx, users, now);
    const status = outcome === 'failed' ? 'failed' : 'rejected';
    tx.update(ref, { status, resolvedBy: by, note, completedAt: now, updatedAt: now });
    return { changed: true, status };
  });
}

// ---------------------------------------------------------------- checking with Fapshi
async function refreshPayment(paymentId, now = Date.now()) {
  const snap = await pay().doc(paymentId).get();
  if (!snap.exists) return null;
  const p = snap.data();
  if (!['pending', 'processing'].includes(p.status)) return p.status;

  const expired = p.type === 'deposit' && now - p.createdAt > cfg.DEPOSIT_EXPIRE_MINUTES * 60000;
  let st = null;
  try {
    if (p.type === 'deposit' && p.providerRef) st = await fapshi.getStatus({ transId: p.providerRef, kind: 'collect' });
    else if (p.type === 'withdrawal' && p.status === 'processing' && p.providerRef) st = await fapshi.getStatus({ transId: p.providerRef, kind: 'payout' });
    else if (p.type === 'withdrawal') return p.status; // waiting for an admin
  } catch (e) {
    console.error('Status check failed', paymentId, e.message);
    return p.status; // try again on the next poll
  }

  if (st && st.status === 'success') {
    if (p.type === 'deposit') {
      if (st.amount !== undefined && st.amount !== p.amount) {
        await setPaymentStatus(paymentId, ['pending'], 'review', { providerAmount: st.amount, note: `Fapshi reports ${st.amount}, expected ${p.amount}` });
        return 'review';
      }
      await finalizeDeposit(paymentId, now);
      return 'success';
    }
    await resolveWithdrawal(paymentId, 'paid', { by: 'fapshi', now, allowed: ['processing'] });
    return 'success';
  }
  if (st && st.status === 'failed') {
    if (p.type === 'deposit') await setPaymentStatus(paymentId, ['pending'], 'failed');
    else await resolveWithdrawal(paymentId, 'failed', { by: 'fapshi', now, note: st.reason || null, allowed: ['processing'] });
    return 'failed';
  }
  if (expired) {
    await setPaymentStatus(paymentId, ['pending'], 'expired');
    return 'expired';
  }
  return p.status;
}

async function checkPayment(uid, data) {
  const id = String(data.paymentId || '');
  if (!ID_RE.test(id)) throw fail('not-found', 'Payment not found.');
  const s = await pay().doc(id).get();
  if (!s.exists || s.data().uid !== uid) throw fail('not-found', 'Payment not found.');
  const status = await refreshPayment(id);
  return { paymentId: id, status };
}

/** Scheduled safety net: re-check anything still open, in case a webhook never arrived. */
async function reconcilePayments(now = Date.now(), max = cfg.RECONCILE_BATCH) {
  const out = { checked: 0, errors: 0, flagged: 0 };

  // A payout claimed long ago but never confirmed: stop and ask a human.
  const sending = await pay().where('status', '==', 'sending').limit(5).get();
  for (const d of sending.docs) {
    if (now - d.data().updatedAt > 10 * 60000) {
      await setPaymentStatus(d.id, ['sending'], 'review', { note: 'Payout was started but never confirmed. Check the Fapshi dashboard.' });
      out.flagged++;
    }
  }

  const processing = await pay().where('status', '==', 'processing').orderBy('createdAt', 'asc').limit(max).get();
  const room = Math.max(0, max - processing.docs.length);
  const pending = room
    ? await pay().where('status', '==', 'pending').where('type', '==', 'deposit').where('createdAt', '<', now - 60 * 1000).orderBy('createdAt', 'asc').limit(room).get()
    : { docs: [] };
  for (const d of [...processing.docs, ...pending.docs]) {
    try { await refreshPayment(d.id, now); out.checked++; } catch (e) { out.errors++; console.error('reconcile', d.id, e); }
  }
  return out;
}

// ---------------------------------------------------------------- webhook
/** Fapshi calls this when a payment or payout changes. We only use it to know what to re-check. */
async function handleFapshiWebhook(headers, body) {
  const secret = cfg.FAPSHI.WEBHOOK_SECRET;
  if (secret && !safeEqual(headers.get('x-wh-secret') || '', secret)) return { code: 401, text: 'unauthorized' };
  const b = body && typeof body === 'object' ? body : {};
  let id = null;
  if (typeof b.externalId === 'string' && ID_RE.test(b.externalId)) {
    if ((await pay().doc(b.externalId).get()).exists) id = b.externalId;
  }
  if (!id && typeof b.transId === 'string' && b.transId) {
    const q = await pay().where('providerRef', '==', b.transId).limit(1).get();
    if (!q.empty) id = q.docs[0].id;
  }
  if (!id) return { code: 200, text: 'ignored' };
  await refreshPayment(id);
  return { code: 200, text: 'ok' };
}

// ---------------------------------------------------------------- admin
async function adminList() {
  const [wp, wr, dr] = await Promise.all([
    pay().where('status', '==', 'pending').where('type', '==', 'withdrawal').limit(100).get(),
    pay().where('status', '==', 'review').where('type', '==', 'withdrawal').limit(50).get(),
    pay().where('status', '==', 'review').where('type', '==', 'deposit').limit(50).get(),
  ]);
  const items = [...wp.docs, ...wr.docs, ...dr.docs].map((d) => ({ id: d.id, ...d.data() }));
  const names = {};
  await Promise.all([...new Set(items.map((i) => i.uid))].map(async (u) => {
    const s = await db.collection('users').doc(u).get();
    names[u] = s.exists ? s.data().displayName : '?';
  }));
  items.sort((a, b) => a.createdAt - b.createdAt);
  return { items: items.map((i) => ({ ...i, displayName: names[i.uid] })), payoutsReady: fapshi.payoutConfigured() };
}

/** action: paid | reject | send (withdrawals) and credit | dismiss (deposits held for review). */
async function adminResolve(data) {
  const id = String(data.paymentId || '');
  if (!ID_RE.test(id)) throw fail('not-found', 'Payment not found.');
  const note = typeof data.note === 'string' ? data.note.slice(0, 200) : null;
  const by = 'admin';
  switch (data.action) {
    case 'send': return sendWithdrawal(id);
    case 'paid': return resolveWithdrawal(id, 'paid', { by, note, allowed: ['pending', 'review'] });
    case 'reject': return resolveWithdrawal(id, 'rejected', { by, note, allowed: ['pending', 'review'] });
    case 'credit': {
      const s = await pay().doc(id).get();
      if (!s.exists) throw fail('not-found', 'Payment not found.');
      const p = s.data();
      if (p.type !== 'deposit' || p.status !== 'review') throw fail('failed-precondition', 'This payment is not waiting for review.');
      const amount = Number.isInteger(p.providerAmount) && p.providerAmount > 0 ? Math.min(p.providerAmount, p.amount) : p.amount;
      const done = await finalizeDeposit(id, Date.now(), { from: ['review'], amount });
      return { changed: done, status: done ? 'success' : p.status, credited: amount };
    }
    case 'dismiss': {
      const ok = await setPaymentStatus(id, ['review'], 'rejected', { note, resolvedBy: by });
      return { changed: ok, status: ok ? 'rejected' : 'unchanged' };
    }
    default: throw fail('invalid-argument', 'Unknown action.');
  }
}

export {
  startDeposit, finalizeDeposit, requestWithdrawal, sendWithdrawal, resolveWithdrawal, refreshPayment, checkPayment,
  reconcilePayments, handleFapshiWebhook, adminList, adminResolve,
};
