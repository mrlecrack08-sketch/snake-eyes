/**
 * Everything that needs the Firebase service account, done with the Web Crypto API so it
 * runs on Cloudflare Workers:
 *   - an OAuth access token for Firestore REST calls,
 *   - a Firebase custom token, so a browser can sign in after the PIN check,
 *   - verification of Firebase ID tokens sent by the browser.
 */
import { b64url, b64urlText, unb64url } from './util.js';

const enc = new TextEncoder();
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CUSTOM_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

const keyCache = new Map();
async function signingKey(pem) {
  if (keyCache.has(pem)) return keyCache.get(pem);
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  keyCache.set(pem, key);
  return key;
}

async function signJwt(payload, sa) {
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64urlText(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(sa.private_key), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

export function parseServiceAccount(text) {
  let sa;
  try { sa = JSON.parse(text); } catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole downloaded key file.'); }
  if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key.');
  return sa;
}

/** Returns a function that gives a (cached) Google access token for Firestore. */
export function accessTokenSource(sa, fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now()) {
  let cached = null;
  let inflight = null;
  return async function getToken() {
    if (cached && cached.exp - 60000 > now()) return cached.token;
    if (inflight) return inflight;
    inflight = (async () => {
      const iat = Math.floor(now() / 1000);
      const jwt = await signJwt({
        iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
        aud: sa.token_uri || TOKEN_URL, iat, exp: iat + 3600,
      }, sa);
      const res = await fetchImpl(sa.token_uri || TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || !json.access_token) throw new Error('Google sign-in for the service account failed: ' + (json && (json.error_description || json.error) || res.status));
      cached = { token: json.access_token, exp: now() + (json.expires_in || 3600) * 1000 };
      return cached.token;
    })().finally(() => { inflight = null; });
    return inflight;
  };
}

/** A Firebase custom token for `uid`. The browser exchanges it with signInWithCustomToken(). */
export function createCustomToken(sa, uid, claims = {}, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  return signJwt({ iss: sa.client_email, sub: sa.client_email, aud: CUSTOM_AUD, iat, exp: iat + 3600, uid, claims }, sa);
}

// ---- verify the browser's Firebase ID token ----
let jwks = { keys: new Map(), exp: 0 };

async function loadKeys(fetchImpl, now) {
  if (jwks.exp > now && jwks.keys.size) return jwks.keys;
  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) throw new Error('Could not load Google signing keys');
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  const json = await res.json();
  const keys = new Map();
  for (const k of json.keys || []) {
    keys.set(k.kid, await crypto.subtle.importKey('jwk', { kty: k.kty, n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  jwks = { keys, exp: now + (maxAge ? Number(maxAge[1]) : 3600) * 1000 };
  return keys;
}

export const _resetKeyCache = () => { jwks = { keys: new Map(), exp: 0 }; };

/** Returns the token's claims if it is a valid, unexpired Firebase ID token for this project, else null. */
export async function verifyIdToken(token, projectId, { fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now() } = {}) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
    if (header.alg !== 'RS256' || !header.kid) return null;
    const sec = Math.floor(now / 1000);
    if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (!claims.sub || typeof claims.sub !== 'string' || claims.sub.length > 128) return null;
    if (!(claims.exp > sec) || !(claims.iat <= sec + 300)) return null;
    let keys = await loadKeys(fetchImpl, now);
    if (!keys.has(header.kid)) { jwks.exp = 0; keys = await loadKeys(fetchImpl, now); }
    const key = keys.get(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    return ok ? claims : null;
  } catch (e) {
    return null;
  }
}
