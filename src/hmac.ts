import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-agent-games-signature';

/**
 * The platform reveals the secret once as plaintext. It is undocumented
 * whether the HMAC key is that text's UTF-8 bytes or its hex-decoded bytes.
 * We accept whichever one the inbound signature proves, and sign responses
 * with the same key. If practice mode reports signature errors, both cases
 * are already covered.
 */
export function candidateKeys(secret: string): Buffer[] {
  const keys = [Buffer.from(secret, 'utf8')];
  if (/^[0-9a-fA-F]{64}$/.test(secret)) keys.push(Buffer.from(secret, 'hex'));
  return keys;
}

export function sign(key: Buffer, body: Buffer | string): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

/**
 * Returns the candidate key that produced `header` over the raw body,
 * or null when the header is missing/malformed/invalid.
 * Runs BEFORE any JSON parsing (server passes the raw Buffer).
 */
export function verify(
  keys: Buffer[],
  rawBody: Buffer,
  header: string | undefined,
): Buffer | null {
  if (!header || keys.length === 0) return null;
  const given = header.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return null;
  const givenBytes = Buffer.from(given, 'hex');
  for (const key of keys) {
    const expected = Buffer.from(sign(key, rawBody), 'hex');
    if (expected.length === givenBytes.length && timingSafeEqual(expected, givenBytes)) {
      return key;
    }
  }
  return null;
}
