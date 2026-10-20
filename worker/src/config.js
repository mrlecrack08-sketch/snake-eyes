/**
 * All tunable settings. Values come from wrangler.toml [vars] (plain settings) and from
 * Worker secrets (keys and passwords). Anything not set falls back to the default below.
 * `configure(env)` is called at the start of every request and cron run.
 */
const DEFAULTS = {
  CURRENCY: 'XAF',

  // ---- Game ----
  ROOM_ENTRY_FEE: 100,
  STAKE_OPTIONS: [10, 20, 50, 100],
  RAKE_PERCENT: 0, // percent of the winner's profit kept by the platform
  IDLE_TURN_SECONDS: 180,
  WAITING_ROOM_SECONDS: 900,
  PRACTICE_IDLE_SECONDS: 1800,

  // ---- Wallet ----
  MIN_DEPOSIT: 100, // Fapshi's minimum is 100 XAF
  MAX_DEPOSIT: 500000,
  MIN_WITHDRAW: 500,
  MAX_WITHDRAW: 200000,
  WITHDRAW_FEE_PERCENT: 0,
  DEPOSIT_EXPIRE_MINUTES: 60,
  AUTO_PAYOUT_MAX: 0, // withdrawals up to this amount are paid automatically (0 = all wait for admin)

  // ---- Referral ----
  REFERRAL_BONUS: 100,
  REFERRAL_MIN_DEPOSIT: 500,

  // ---- Accounts ----
  PIN_ITERATIONS: 5000,
  PIN_MAX_FAILURES: 5,
  PIN_LOCK_MINUTES: 15,

  // ---- Cron batch sizes (the free plan allows 50 outgoing calls per run) ----
  SWEEP_BATCH: 5,
  RECONCILE_BATCH: 3,

  // ---- Site ----
  APP_BASE_URL: '',
  ALLOWED_ORIGINS: [],

  // ---- Secrets ----
  FIREBASE_SERVICE_ACCOUNT: '',
  ADMIN_KEY: '',
  PIN_PEPPER: '',

  // ---- Fapshi ----
  FAPSHI: {
    ENV: 'sandbox', // 'sandbox' or 'live'
    BASE_URL: '',
    DEPOSIT_MODE: 'direct', // 'direct' = payment request on the phone, 'link' = Fapshi checkout page
    COLLECT_USER: '', COLLECT_KEY: '',
    PAYOUT_USER: '', PAYOUT_KEY: '',
    WEBHOOK_SECRET: '',
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
export const cfg = clone(DEFAULTS);

const has = (env, k) => env[k] !== undefined && env[k] !== null && String(env[k]).trim() !== '';
const num = (env, k, d) => (has(env, k) && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
const str = (env, k, d = '') => (has(env, k) ? String(env[k]).trim() : d);
const list = (env, k, d) => (has(env, k) ? String(env[k]).split(',').map((s) => s.trim()).filter(Boolean) : d);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function configure(env = {}) {
  const d = DEFAULTS;
  cfg.ROOM_ENTRY_FEE = Math.max(1, Math.floor(num(env, 'ROOM_ENTRY_FEE', d.ROOM_ENTRY_FEE)));
  const stakes = list(env, 'STAKE_OPTIONS', null);
  cfg.STAKE_OPTIONS = stakes ? stakes.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [...d.STAKE_OPTIONS];
  cfg.RAKE_PERCENT = clamp(num(env, 'RAKE_PERCENT', d.RAKE_PERCENT), 0, 30);
  cfg.IDLE_TURN_SECONDS = num(env, 'IDLE_TURN_SECONDS', d.IDLE_TURN_SECONDS);
  cfg.WAITING_ROOM_SECONDS = num(env, 'WAITING_ROOM_SECONDS', d.WAITING_ROOM_SECONDS);
  cfg.PRACTICE_IDLE_SECONDS = num(env, 'PRACTICE_IDLE_SECONDS', d.PRACTICE_IDLE_SECONDS);

  cfg.MIN_DEPOSIT = Math.max(100, num(env, 'MIN_DEPOSIT', d.MIN_DEPOSIT));
  cfg.MAX_DEPOSIT = num(env, 'MAX_DEPOSIT', d.MAX_DEPOSIT);
  cfg.MIN_WITHDRAW = Math.max(100, num(env, 'MIN_WITHDRAW', d.MIN_WITHDRAW));
  cfg.MAX_WITHDRAW = num(env, 'MAX_WITHDRAW', d.MAX_WITHDRAW);
  cfg.WITHDRAW_FEE_PERCENT = clamp(num(env, 'WITHDRAW_FEE_PERCENT', d.WITHDRAW_FEE_PERCENT), 0, 20);
  cfg.DEPOSIT_EXPIRE_MINUTES = num(env, 'DEPOSIT_EXPIRE_MINUTES', d.DEPOSIT_EXPIRE_MINUTES);
  cfg.AUTO_PAYOUT_MAX = Math.max(0, num(env, 'AUTO_PAYOUT_MAX', d.AUTO_PAYOUT_MAX));

  cfg.REFERRAL_BONUS = num(env, 'REFERRAL_BONUS', d.REFERRAL_BONUS);
  cfg.REFERRAL_MIN_DEPOSIT = num(env, 'REFERRAL_MIN_DEPOSIT', d.REFERRAL_MIN_DEPOSIT);

  cfg.PIN_ITERATIONS = Math.max(1000, num(env, 'PIN_ITERATIONS', d.PIN_ITERATIONS));
  cfg.PIN_MAX_FAILURES = Math.max(3, num(env, 'PIN_MAX_FAILURES', d.PIN_MAX_FAILURES));
  cfg.PIN_LOCK_MINUTES = Math.max(1, num(env, 'PIN_LOCK_MINUTES', d.PIN_LOCK_MINUTES));
  cfg.SWEEP_BATCH = Math.max(1, num(env, 'SWEEP_BATCH', d.SWEEP_BATCH));
  cfg.RECONCILE_BATCH = Math.max(1, num(env, 'RECONCILE_BATCH', d.RECONCILE_BATCH));

  cfg.APP_BASE_URL = str(env, 'APP_BASE_URL').replace(/\/+$/, '');
  cfg.ALLOWED_ORIGINS = list(env, 'ALLOWED_ORIGINS', []).map((s) => s.replace(/\/+$/, ''));
  cfg.FIREBASE_SERVICE_ACCOUNT = str(env, 'FIREBASE_SERVICE_ACCOUNT');
  cfg.ADMIN_KEY = str(env, 'ADMIN_KEY');
  cfg.PIN_PEPPER = str(env, 'PIN_PEPPER');

  const live = str(env, 'FAPSHI_ENV', 'sandbox').toLowerCase() === 'live';
  cfg.FAPSHI = {
    ENV: live ? 'live' : 'sandbox',
    BASE_URL: str(env, 'FAPSHI_BASE_URL', live ? 'https://live.fapshi.com' : 'https://sandbox.fapshi.com').replace(/\/+$/, ''),
    DEPOSIT_MODE: str(env, 'FAPSHI_DEPOSIT_MODE', 'direct').toLowerCase() === 'link' ? 'link' : 'direct',
    COLLECT_USER: str(env, 'FAPSHI_COLLECT_USER'),
    COLLECT_KEY: str(env, 'FAPSHI_COLLECT_KEY'),
    PAYOUT_USER: str(env, 'FAPSHI_PAYOUT_USER'),
    PAYOUT_KEY: str(env, 'FAPSHI_PAYOUT_KEY'),
    WEBHOOK_SECRET: str(env, 'FAPSHI_WEBHOOK_SECRET'),
  };
  return cfg;
}
