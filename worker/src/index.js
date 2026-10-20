/**
 * Snake Eyes server: one Cloudflare Worker.
 *
 *   POST /api/<name>             the game API called by the website (JSON in, JSON out)
 *   POST /api/admin/<name>       admin tools, protected by the ADMIN_KEY secret
 *   POST /api/fapshi-webhook     Fapshi tells us a payment or payout changed
 *   cron                         every minute: close idle rooms; every 2 minutes: re-check payments
 */
import { cfg, configure } from './config.js';
import { setDb } from './fb.js';
import { Firestore } from './firestore.js';
import { accessTokenSource, createCustomToken, parseServiceAccount, verifyIdToken } from './google.js';
import { fail, statusOf, toClientError } from './errors.js';
import { safeEqual } from './util.js';
import * as users from './users.js';
import * as auth from './auth.js';
import * as rooms from './rooms.js';
import * as payments from './payments.js';

export const CRON_SWEEP = '* * * * *';
export const CRON_RECONCILE = '*/2 * * * *';
const MAX_BODY = 20000;

// ---- one Firestore client per running Worker instance ----
let booted = null;
function boot(env) {
  configure(env);
  if (!cfg.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set. See the README, step 4.');
  if (!booted || booted.key !== cfg.FIREBASE_SERVICE_ACCOUNT) {
    const sa = parseServiceAccount(cfg.FIREBASE_SERVICE_ACCOUNT);
    booted = {
      key: cfg.FIREBASE_SERVICE_ACCOUNT, sa, projectId: sa.project_id,
      db: new Firestore({ projectId: sa.project_id, getToken: accessTokenSource(sa) }),
    };
  }
  setDb(booted.db);
  return booted;
}

// ---- routes ----
// [handler, needsSignIn]. Handlers get (uid, data, ctx) and return plain JSON.
const mintFor = (b) => async ({ uid, phone }) => ({ uid, token: await createCustomToken(b.sa, uid, { phone }) });

const ROUTES = {
  getConfig: [async () => users.publicConfig(), false],
  register: [async (_u, d, c) => c.mint(await auth.register(d)), false],
  login: [async (_u, d, c) => c.mint(await auth.login(d)), false],
  changePin: [(uid, d) => auth.changePin(uid, d), true],

  createRoom: [(uid, d) => rooms.createRoom(uid, d), true],
  joinRoom: [(uid, d) => rooms.joinRoom(uid, d), true],
  cancelRoom: [(uid, d) => rooms.cancelRoom(uid, d), true],
  startRound: [(uid, d) => rooms.startRound(uid, d), true],
  rollDice: [(uid, d) => rooms.rollDice(uid, d), true],
  forfeitRoom: [(uid, d) => rooms.forfeitRoom(uid, d), true],

  startDeposit: [(uid, d) => payments.startDeposit(uid, d), true],
  checkPayment: [(uid, d) => payments.checkPayment(uid, d), true],
  requestWithdrawal: [(uid, d) => payments.requestWithdrawal(uid, d), true],
};

const ADMIN_ROUTES = {
  list: () => payments.adminList(),
  resolve: (d) => payments.adminResolve(d),
  resetPin: (d) => auth.adminResetPin(d),
};

// ---- CORS ----
function allowedOrigin(origin, projectId) {
  if (!origin) return null;
  const ok = new Set([
    `https://${projectId}.web.app`, `https://${projectId}.firebaseapp.com`,
    'http://localhost:5000', 'http://127.0.0.1:5000',
    ...(cfg.APP_BASE_URL ? [cfg.APP_BASE_URL] : []), ...cfg.ALLOWED_ORIGINS,
  ]);
  return ok.has(origin) ? origin : null;
}

function corsHeaders(origin, projectId) {
  const allow = allowedOrigin(origin, projectId);
  const h = { Vary: 'Origin' };
  if (allow) {
    h['Access-Control-Allow-Origin'] = allow;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-Admin-Key';
    h['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw fail('invalid-argument', 'Request too large.');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    throw fail('invalid-argument', 'Request body must be JSON.');
  }
}

async function signedInUid(request, b) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer (.+)$/.exec(h);
  const claims = m ? await verifyIdToken(m[1], b.projectId) : null;
  if (!claims) throw fail('unauthenticated', 'Please sign in again.');
  return claims.sub;
}

function checkAdmin(request) {
  if (!cfg.ADMIN_KEY || cfg.ADMIN_KEY.length < 16) throw fail('failed-precondition', 'Admin is switched off: set the ADMIN_KEY secret (at least 16 characters).');
  if (!safeEqual(request.headers.get('X-Admin-Key') || '', cfg.ADMIN_KEY)) throw fail('permission-denied', 'Wrong admin key.');
}

// ---- main entry points ----
export async function handleFetch(request, env) {
  let b = null;
  let cors = { Vary: 'Origin' };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  try {
    b = boot(env);
    cors = corsHeaders(request.headers.get('Origin'), b.projectId);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (path === '/' || path === '/api/health') return json(200, { ok: true, service: 'snake-eyes', fapshi: cfg.FAPSHI.ENV });

    if (path === '/api/fapshi-webhook') {
      if (request.method !== 'POST') return json(405, { ok: false });
      let body = {};
      try { body = await readJson(request); } catch (e) { return json(400, { ok: false }); }
      const r = await payments.handleFapshiWebhook(request.headers, body);
      return new Response(r.text, { status: r.code, headers: cors });
    }

    if (request.method !== 'POST') return json(405, { ok: false, error: { code: 'invalid-argument', message: 'Use POST.' } });
    const data = await readJson(request);

    if (path.startsWith('/api/admin/')) {
      checkAdmin(request);
      const fn = ADMIN_ROUTES[path.slice('/api/admin/'.length)];
      if (!fn) throw fail('not-found', 'Unknown admin action.');
      return json(200, { ok: true, data: await fn(data) });
    }

    const route = path.startsWith('/api/') ? ROUTES[path.slice(5)] : null;
    if (!route || !Object.prototype.hasOwnProperty.call(ROUTES, path.slice(5))) throw fail('not-found', 'Unknown request.');
    const [fn, needsSignIn] = route;
    const uid = needsSignIn ? await signedInUid(request, b) : null;
    return json(200, { ok: true, data: await fn(uid, data, { mint: mintFor(b) }) });
  } catch (e) {
    const err = toClientError(e);
    return json(statusOf(err.code), { ok: false, error: err });
  }
}

export async function handleScheduled(event, env) {
  boot(env);
  if (event.cron === CRON_RECONCILE) console.log('reconcilePayments', JSON.stringify(await payments.reconcilePayments()));
  else console.log('sweepRooms', JSON.stringify(await rooms.sweepRooms()));
}

export default {
  fetch: (request, env) => handleFetch(request, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(handleScheduled(event, env)),
};
