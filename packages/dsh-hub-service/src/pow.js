import crypto from 'node:crypto';

export function verifyPow({ challenge, nonce, difficulty }) {
  if (!challenge || typeof challenge !== 'string') return false;
  if (!nonce || typeof nonce !== 'string') return false;
  if (!Number.isSafeInteger(difficulty) || difficulty < 0 || difficulty > 30) return false;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(nonce)) return false;
  const digest = crypto.createHash('sha256')
    .update(challenge, 'utf8')
    .update(':', 'utf8')
    .update(nonce, 'utf8')
    .digest();
  return hasLeadingZeroBits(digest, difficulty);
}

function hasLeadingZeroBits(buffer, bits) {
  let remaining = bits;
  for (const byte of buffer) {
    if (remaining <= 0) return true;
    if (remaining >= 8) {
      if (byte !== 0) return false;
      remaining -= 8;
      continue;
    }
    const mask = 0xff << (8 - remaining) & 0xff;
    return (byte & mask) === 0;
  }
  return remaining <= 0;
}
