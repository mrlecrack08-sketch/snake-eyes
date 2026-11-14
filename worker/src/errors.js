/** An error whose message is safe to show to the player. `code` follows the usual gRPC-style names. */
export class HttpError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.details = details;
  }
}

export const fail = (code, message, details) => new HttpError(code, message, details);

const STATUS = {
  'invalid-argument': 400,
  unauthenticated: 401,
  'permission-denied': 403,
  'not-found': 404,
  'already-exists': 409,
  'failed-precondition': 412,
  'resource-exhausted': 429,
  internal: 500,
  unavailable: 503,
};

export const statusOf = (code) => STATUS[code] || 500;

/** Turn anything thrown into a client-safe {code, message, details}. Engine errors carry a code too. */
export function toClientError(e) {
  if (e && (e.name === 'HttpError' || e.name === 'GameError') && STATUS[e.code]) {
    return { code: e.code, message: e.message, details: e.details };
  }
  console.error('Unexpected error', e && e.stack ? e.stack : e);
  return { code: 'internal', message: 'Something went wrong. Please try again.' };
}
