// The Worker as the website and Fapshi see it: real HTTP requests in, JSON out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, env, exchangeCustomToken, idToken } from './helpers/world.js';
import { handleFetch, handleScheduled, CRON_SWEEP, CRON_RECONCILE } from '../src/index.js';
import worker from '../src/index.js';

const world = createWorld();
world.install();
const PIN = '482913';
const HOST = 'https://api.example.workers.dev';
let maxCalls = 0; // most outgoing calls any single request made (the free plan allows 50)

async function api(path, { body, token, method = 'POST', headers = {}, e = env, raw } = {}) {
  const before = world.log.length;
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const res = await handleFetch(new Request(HOST + path, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined }), e);
  maxCalls = Math.max(maxCalls, world.log.length - before);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const must = async (path, opts) => { const r = await api(path, opts); assert.equal(r.status, 200, `${path}: ${r.text}`); return r.json.data; };
const reset = () => { world.reset(); };

async function signUp(n, name, extra = {}) {
  const phone = `67000000${n}`;
  const r = await must('/api/register', { body: { phone, pin: PIN, displayName: name, adult: true, ...extra } });
  const ex = exchangeCustomToken(r.token); // what signInWithCustomToken does
  assert.equal(ex.uid, r.uid);
  return { uid: r.uid, token: ex.idToken, phone: `+237${phone}` };
}
async function topUp(p, amount) {
  const d = await must('/api/startDeposit', { token: p.token, body: { amount } });
  const t = world.fapshi.find(d.paymentId);
  world.fapshi.settle(t.transId, 'SUCCESSFUL');
  const r = await api('/api/fapshi-webhook', { body: { transId: t.transId, externalId: d.paymentId }, headers: { 'x-wh-secret': 'hook-secret' } });
  assert.equal(r.status, 200);
}
const balance = (p) => world.raw(`users/${p.uid}`).balance;

test('health, config, unknown routes, wrong methods, bad bodies', async () => {
  reset();
  assert.deepEqual((await api('/api/health', { method: 'GET' })).json, { ok: true, service: 'snake-eyes', fapshi: 'sandbox' });
  const c = await must('/api/getConfig', { body: {} });
  assert.deepEqual([c.entryFee, c.stakeOptions, c.currency, c.depositMode], [100, [10, 20, 50, 100], 'XAF', 'direct']);
  assert.equal((await api('/api/nothing', { body: {} })).status, 404);
  assert.equal((await api('/api/constructor', { body: {} })).status, 404, 'prototype names are not routes');
  assert.equal((await api('/api/__proto__', { body: {} })).status, 404);
  assert.equal((await api('/api/getConfig', { method: 'GET' })).status, 405);
  const bad = await api('/api/login', { raw: '{nope' });
  assert.deepEqual([bad.status, bad.json.error.code], [400, 'invalid-argument']);
  const big = await api('/api/login', { raw: JSON.stringify({ x: 'a'.repeat(30000) }) });
  assert.equal(big.status, 400);
  assert.equal((await api('/api/login', { raw: '[1,2]' })).status, 400, 'arrays are not accepted as a body');
});

test('CORS: the website origin is allowed, strangers are not', async () => {
  reset();
  const pre = await api('/api/login', { method: 'OPTIONS', headers: { Origin: 'https://test-project.web.app', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://test-project.web.app');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  const ok = await api('/api/getConfig', { body: {}, headers: { Origin: 'https://game.example' } }); // APP_BASE_URL
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://game.example');
  const evil = await api('/api/getConfig', { body: {}, headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const extra = await api('/api/getConfig', { body: {}, headers: { Origin: 'https://mine.example' }, e: { ...env, ALLOWED_ORIGINS: 'https://mine.example/' } });
  assert.equal(extra.headers.get('access-control-allow-origin'), 'https://mine.example');
});

test('sign-up and sign-in return a Firebase custom token; protected calls need a valid ID token', async () => {
  reset();
  const ann = await signUp(1, 'Ann');
  const again = await api('/api/register', { body: { phone: '670000001', pin: PIN, displayName: 'Ann', adult: true } });
  assert.deepEqual([again.status, again.json.error.code], [409, 'already-exists']);

  const wrong = await api('/api/login', { body: { phone: '670000001', pin: '000111' } });
  assert.deepEqual([wrong.status, wrong.json.error.code], [403, 'permission-denied']);
  assert.match(wrong.json.error.message, /4 tries left/);
  assert.equal(wrong.json.token, undefined);
  const login = await must('/api/login', { body: { phone: '+237 670 000 001', pin: PIN } });
  assert.equal(exchangeCustomToken(login.token).uid, ann.uid);

  for (let i = 0; i < 5; i++) await api('/api/login', { body: { phone: '670000001', pin: '000111' } });
  const locked = await api('/api/login', { body: { phone: '670000001', pin: PIN } });
  assert.deepEqual([locked.status, locked.json.error.code], [429, 'resource-exhausted']);

  // protected calls
  const none = await api('/api/createRoom', { body: { mode: 'ai' } });
  assert.deepEqual([none.status, none.json.error.code], [401, 'unauthenticated']);
  for (const token of ['garbage', idToken('x', {}, { expiresIn: -5 }), idToken('x', {}, { aud: 'other' }), ann.token.slice(0, -4) + 'AAAA']) {
    assert.equal((await api('/api/createRoom', { body: { mode: 'ai' }, token })).status, 401);
  }
  assert.equal((await api('/api/createRoom', { body: { mode: 'ai' }, headers: { Authorization: 'Basic abc' } })).status, 401);
  const room = await must('/api/createRoom', { token: ann.token, body: { mode: 'ai' } });
  assert.ok(room.roomId);
  // a valid token for someone who never registered cannot do anything useful
  const ghost = await api('/api/createRoom', { token: idToken('u237699999999'), body: { mode: 'pvp' } });
  assert.equal(ghost.status, 412);
});

test('a full game over HTTP: deposit by webhook, two players, play to the end, withdraw with PIN', async () => {
  reset();
  const ann = await signUp(1, 'Ann');
  const bob = await signUp(2, 'Bob');
  await topUp(ann, 1000);
  await topUp(bob, 1000);
  assert.deepEqual([balance(ann), balance(bob)], [1000, 1000]);

  const { roomId, code } = await must('/api/createRoom', { token: ann.token, body: { mode: 'pvp', visibility: 'public' } });
  assert.match(code, /^[A-Z2-9]{5}$/);
  assert.equal((await api('/api/joinRoom', { token: bob.token, body: { code: 'ZZZZZ' } })).status, 404);
  await must('/api/joinRoom', { token: bob.token, body: { code: code.toLowerCase() } });
  assert.deepEqual([balance(ann), balance(bob)], [900, 900]);

  let room = world.raw(`rooms/${roomId}`);
  const tokens = { [ann.uid]: ann.token, [bob.uid]: bob.token };
  for (let i = 0; room.status === 'playing' && i < 2000; i++) {
    if (room.phase === 'stake') await must('/api/startRound', { token: ann.token, body: { roomId, stake: room.allowed[room.allowed.length - 1] } });
    else await must('/api/rollDice', { token: tokens[room.cur.queue[0]], body: { roomId } });
    room = world.raw(`rooms/${roomId}`);
  }
  assert.equal(room.status, 'finished');
  assert.equal(balance(ann) + balance(bob), 2000);
  assert.equal(world.raw(`users/${ann.uid}`).activeRoomId, null);

  const winner = room.result.winnerUid === ann.uid ? ann : bob;
  const cash = balance(winner);
  const noPin = await api('/api/requestWithdrawal', { token: winner.token, body: { amount: 1000 } });
  assert.equal(noPin.status, 400);
  const wd = await must('/api/requestWithdrawal', { token: winner.token, body: { amount: 1000, pin: PIN } });
  assert.equal(wd.status, 'pending');
  assert.equal(balance(winner), cash - 1000);

  // admin pays it through Fapshi
  const list = await must('/api/admin/list', { headers: { 'X-Admin-Key': env.ADMIN_KEY }, body: {} });
  assert.equal(list.items.length, 1);
  assert.equal(list.payoutsReady, true);
  await must('/api/admin/resolve', { headers: { 'X-Admin-Key': env.ADMIN_KEY }, body: { paymentId: wd.paymentId, action: 'send' } });
  world.fapshi.settle(world.raw(`payments/${wd.paymentId}`).providerRef, 'SUCCESSFUL');
  await handleScheduled({ cron: CRON_RECONCILE }, env);
  assert.equal(world.raw(`payments/${wd.paymentId}`).status, 'success');
});

test('payment polling by the website works for the owner only', async () => {
  reset();
  const ann = await signUp(1, 'Ann');
  const bob = await signUp(2, 'Bob');
  const d = await must('/api/startDeposit', { token: ann.token, body: { amount: 500, provider: 'mtn' } });
  assert.equal((await must('/api/checkPayment', { token: ann.token, body: { paymentId: d.paymentId } })).status, 'pending');
  assert.equal((await api('/api/checkPayment', { token: bob.token, body: { paymentId: d.paymentId } })).status, 404);
  world.fapshi.settle(world.fapshi.find(d.paymentId).transId, 'SUCCESSFUL');
  assert.equal((await must('/api/checkPayment', { token: ann.token, body: { paymentId: d.paymentId } })).status, 'success');
  assert.equal(balance(ann), 500);
});

test('Fapshi webhook route: secret required when configured', async () => {
  reset();
  const ann = await signUp(1, 'Ann');
  const d = await must('/api/startDeposit', { token: ann.token, body: { amount: 500 } });
  const t = world.fapshi.find(d.paymentId);
  world.fapshi.settle(t.transId, 'SUCCESSFUL');
  assert.equal((await api('/api/fapshi-webhook', { body: { transId: t.transId } })).status, 401);
  assert.equal((await api('/api/fapshi-webhook', { body: { transId: t.transId }, headers: { 'x-wh-secret': 'wrong' } })).status, 401);
  assert.equal(balance(ann), 0);
  assert.equal((await api('/api/fapshi-webhook', { method: 'GET' })).status, 405);
  assert.equal((await api('/api/fapshi-webhook', { raw: 'junk', headers: { 'x-wh-secret': 'hook-secret' } })).status, 400);
  const ok = await api('/api/fapshi-webhook', { body: { transId: t.transId, externalId: d.paymentId, status: 'SUCCESSFUL' }, headers: { 'x-wh-secret': 'hook-secret' } });
  assert.deepEqual([ok.status, ok.text], [200, 'ok']);
  assert.equal(balance(ann), 500);
});

test('admin: off without a key, closed to the wrong key, can reset a PIN', async () => {
  reset();
  const ann = await signUp(1, 'Ann');
  const off = await api('/api/admin/list', { body: {}, e: { ...env, ADMIN_KEY: '' } });
  assert.deepEqual([off.status, off.json.error.code], [412, 'failed-precondition']);
  assert.equal((await api('/api/admin/list', { body: {}, e: { ...env, ADMIN_KEY: 'short' }, headers: { 'X-Admin-Key': 'short' } })).status, 412, 'a short key is refused');
  assert.equal((await api('/api/admin/list', { body: {} })).status, 403);
  assert.equal((await api('/api/admin/list', { body: {}, headers: { 'X-Admin-Key': 'nope' } })).status, 403);
  assert.equal((await api('/api/admin/list', { body: {}, token: ann.token })).status, 403, 'a player token is not an admin key');
  assert.equal((await api('/api/admin/other', { body: {}, headers: { 'X-Admin-Key': env.ADMIN_KEY } })).status, 404);

  for (let i = 0; i < 5; i++) await api('/api/login', { body: { phone: '670000001', pin: '000111' } });
  assert.equal((await api('/api/login', { body: { phone: '670000001', pin: PIN } })).status, 429);
  const r = await must('/api/admin/resetPin', { headers: { 'X-Admin-Key': env.ADMIN_KEY }, body: { phone: '670000001', newPin: '582016' } });
  assert.equal(r.name, 'Ann');
  await must('/api/login', { body: { phone: '670000001', pin: '582016' } });
});

test('the website can change its PIN', async () => {
  reset();
  const ann = await signUp(1, 'Ann');
  assert.equal((await api('/api/changePin', { token: ann.token, body: { pin: '000111', newPin: '739104' } })).status, 403);
  await must('/api/changePin', { token: ann.token, body: { pin: PIN, newPin: '739104' } });
  assert.equal((await api('/api/login', { body: { phone: '670000001', pin: PIN } })).status, 403);
  await must('/api/login', { body: { phone: '670000001', pin: '739104' } });
});

test('cron: one run closes idle rooms; another re-checks payments', async () => {
  reset();
  const ann = await signUp(1, 'Ann');
  await topUp(ann, 500);
  const { roomId } = await must('/api/createRoom', { token: ann.token, body: { mode: 'pvp' } });
  assert.equal(balance(ann), 400);
  // pretend 20 minutes passed: the empty room is cancelled and refunded
  const real = Date.now;
  Date.now = () => real() + 20 * 60 * 1000;
  try { await handleScheduled({ cron: CRON_SWEEP }, env); } finally { Date.now = real; }
  assert.equal(world.raw(`rooms/${roomId}`).status, 'finished');
  assert.equal(balance(ann), 500);

  const d = await must('/api/startDeposit', { token: ann.token, body: { amount: 700 } });
  world.fapshi.settle(world.fapshi.find(d.paymentId).transId, 'SUCCESSFUL');
  Date.now = () => real() + 5 * 60 * 1000; // the cron only picks up payments older than a minute
  try { await handleScheduled({ cron: CRON_RECONCILE }, env); } finally { Date.now = real; }
  assert.equal(balance(ann), 1200);
  // the exported object has both entry points Cloudflare calls
  assert.equal(typeof worker.fetch, 'function');
  let waited = null;
  worker.scheduled({ cron: CRON_SWEEP }, env, { waitUntil: (p) => { waited = p; } });
  await waited;
});

test('misconfiguration gives a clear error instead of a crash', async () => {
  reset();
  const r = await api('/api/getConfig', { body: {}, e: { ...env, FIREBASE_SERVICE_ACCOUNT: '' } });
  assert.equal(r.status, 500);
  assert.equal(r.json.error.code, 'internal');
  assert.ok(!r.text.includes('FIREBASE_SERVICE_ACCOUNT'), 'internal details are not shown to players');
  const noPepper = await api('/api/register', { body: { phone: '670000005', pin: PIN, displayName: 'Eve', adult: true }, e: { ...env, PIN_PEPPER: '' } });
  assert.equal(noPepper.status, 500);
  assert.equal(world.raw('users/u237670000005'), undefined);
});

test('free plan budget: no request makes more than 50 outgoing calls', () => {
  assert.ok(maxCalls < 50, `a request made ${maxCalls} calls`);
  console.log('most outgoing calls in one request:', maxCalls);
});
