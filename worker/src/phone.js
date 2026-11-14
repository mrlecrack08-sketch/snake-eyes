/**
 * Cameroon phone numbers: 9 digits starting with 6 (mobile), country code +237.
 * Accepts: 6XXXXXXXX, 6 XX XX XX XX, +237 6XXXXXXXX, 237 6XXXXXXXX, 00237 6XXXXXXXX.
 */
function normalizeCM(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(/[\s().-]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('237') && s.length === 12) s = s.slice(3);
  if (!/^6\d{8}$/.test(s)) return null;
  return '+237' + s;
}

/** MTN/Orange want digits only, with country code and no plus sign. */
function msisdn(e164) {
  return String(e164).replace(/^\+/, '');
}

/** Rough operator hint from the prefix. Only a hint: numbers can be ported. */
function operatorHint(e164) {
  const n = String(e164).replace(/^\+237/, '');
  const p3 = n.slice(0, 3);
  const p2 = n.slice(0, 2);
  if (p2 === '67' || ['650', '651', '652', '653', '654', '680', '681', '682', '683', '684'].includes(p3)) return 'mtn';
  if (p2 === '69' || ['655', '656', '657', '658', '659', '686', '687', '688', '689'].includes(p3)) return 'orange';
  return null;
}

export { normalizeCM, msisdn, operatorHint };
