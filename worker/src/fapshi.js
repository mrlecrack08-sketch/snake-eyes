/**
 * Fapshi (https://fapshi.com) client: one API that covers both MTN MoMo and Orange Money.
 *
 *   POST /direct-pay            ask a phone to approve a payment (deposit, "direct" mode)
 *   POST /initiate-pay          get a Fapshi checkout link (deposit, "link" mode)
 *   GET  /payment-status/{id}   read the real state of a payment or payout
 *   POST /payout                send money to a phone (withdrawal)
 *
 * Deposits use the COLLECTION service keys, payouts use the PAYOUT service keys (Fapshi does not
 * let one service do both). We never trust a webhook body: it only tells us which payment to
 * re-check with getStatus().
 */
import { cfg } from './config.js';
import { httpJson } from './util.js';

const MEDIUM = { mtn: 'mobile money', orange: 'orange money' };
const localNumber = (e164) => String(e164).replace(/^\+237/, '');

/** `definite` = Fapshi clearly said no (safe to retry or give up). Otherwise the outcome is unknown. */
export class ProviderError extends Error {
  constructor(message, { definite = false, status = 0 } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.definite = definite;
    this.status = status;
  }
}

export const collectConfigured = () => !!(cfg.FAPSHI.COLLECT_USER && cfg.FAPSHI.COLLECT_KEY);
export const payoutConfigured = () => !!(cfg.FAPSHI.PAYOUT_USER && cfg.FAPSHI.PAYOUT_KEY);

function creds(kind) {
  const f = cfg.FAPSHI;
  const user = kind === 'payout' ? f.PAYOUT_USER : f.COLLECT_USER;
  const key = kind === 'payout' ? f.PAYOUT_KEY : f.COLLECT_KEY;
  if (!user || !key) throw new ProviderError(`Fapshi ${kind === 'payout' ? 'payout' : 'collection'} keys are not set.`, { definite: true });
  return { apiuser: user, apikey: key };
}

async function send(kind, method, path, body) {
  const headers = creds(kind);
  let r;
  try {
    r = await httpJson(`${cfg.FAPSHI.BASE_URL}${path}`, { method, headers, body, timeoutMs: 20000 });
  } catch (e) {
    throw new ProviderError('Could not reach Fapshi: ' + e.message, { definite: false });
  }
  return r;
}

const reason = (r) => (r.json && r.json.message) || `HTTP ${r.status}`;

/** Start a deposit. Returns {providerRef, payUrl?}. */
export async function requestDeposit({ paymentId, amount, phone, provider, uid, name }) {
  if (cfg.FAPSHI.DEPOSIT_MODE === 'link') {
    const r = await send('collect', 'POST', '/initiate-pay', {
      amount, userId: uid, externalId: paymentId, message: 'Snake Eyes deposit',
      redirectUrl: `${cfg.APP_BASE_URL}/?pay=${paymentId}`,
    });
    if (!r.ok || !r.json || !r.json.transId || !r.json.link) throw new ProviderError(`Fapshi refused the payment link: ${reason(r)}`, { definite: r.status >= 400 && r.status < 500, status: r.status });
    return { providerRef: r.json.transId, payUrl: r.json.link };
  }
  const body = { amount, phone: localNumber(phone), userId: uid, externalId: paymentId, message: 'Snake Eyes deposit' };
  if (MEDIUM[provider]) body.medium = MEDIUM[provider];
  if (name) body.name = name;
  const r = await send('collect', 'POST', '/direct-pay', body);
  if (!r.ok || !r.json || !r.json.transId) throw new ProviderError(`Fapshi refused the payment request: ${reason(r)}`, { definite: r.status >= 400 && r.status < 500, status: r.status });
  return { providerRef: r.json.transId };
}

/** Read a payment or payout. status is one of 'success' | 'failed' | 'pending'. */
export async function getStatus({ transId, kind = 'collect' }) {
  const r = await send(kind, 'GET', `/payment-status/${encodeURIComponent(transId)}`);
  if (r.status === 429) return { status: 'pending', throttled: true }; // Fapshi allows 6 checks a minute per payment
  if (!r.ok || !r.json || !r.json.status) throw new ProviderError(`Fapshi status check failed: ${reason(r)}`, { status: r.status });
  const s = String(r.json.status).toUpperCase();
  const status = s === 'SUCCESSFUL' ? 'success' : s === 'FAILED' || s === 'EXPIRED' ? 'failed' : 'pending';
  return {
    status, amount: Number.isFinite(Number(r.json.amount)) ? Number(r.json.amount) : undefined,
    externalId: r.json.externalId, transType: r.json.transType, raw: s, reason: r.json.reason,
  };
}

/** Send money to a phone. Returns {providerRef}. */
export async function payout({ paymentId, amount, phone, provider, uid }) {
  const body = { amount, phone: localNumber(phone), userId: uid, externalId: paymentId, message: 'Snake Eyes withdrawal' };
  if (MEDIUM[provider]) body.medium = MEDIUM[provider];
  const r = await send('payout', 'POST', '/payout', body);
  if (!r.ok || !r.json || !r.json.transId) {
    // 4xx = Fapshi refused, nothing was sent. Anything else: we cannot be sure.
    throw new ProviderError(`Fapshi refused the payout: ${reason(r)}`, { definite: r.status >= 400 && r.status < 500, status: r.status });
  }
  return { providerRef: r.json.transId };
}
