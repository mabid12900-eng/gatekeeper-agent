/**
 * Reason codes for the response `reason_code` field.
 *
 * The six trap codes are taken verbatim from the official event page
 * ("Trap encyclopedia"). The last seven are NOT documented by the platform -
 * they are needed to fail closed. If practice mode ever complains about them,
 * they are the first thing to adjust (README -> "Known unknowns").
 */
export const REASON_CODES = {
  VALID: 'VALID_CONDITION',
  PROOF_REUSED: 'PROOF_REUSED',
  VK_SUBSTITUTION: 'VK_SUBSTITUTION',
  THRESHOLD_MISMATCH: 'THRESHOLD_MISMATCH',
  EXPIRED_CONDITION: 'EXPIRED_CONDITION',
  RECIPIENT_MISMATCH: 'RECIPIENT_MISMATCH',
  AMOUNT_OVERFLOW: 'AMOUNT_OVERFLOW',
  PROOF_FAILED: 'PROOF_FAILED',
  TIMEOUT: 'TIMEOUT',
  STALE_TIMESTAMP: 'STALE_TIMESTAMP',
  MALFORMED_INPUT: 'MALFORMED_INPUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  WARMING_UP: 'WARMING_UP',
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];
