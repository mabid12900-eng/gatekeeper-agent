/**
 * The decision checks. Pure: same input, same verdict, always.
 * A language model never touches this path.
 *
 * Order matters: the first failing check names the trap.
 * The exact semantics (>= vs >) are confirmed against the real circuit:
 * currentBlock == expiryBlock is already EXPIRED (probed locally).
 */
export interface GatekeeperInput {
  registeredVk: bigint;
  proofVk: bigint;
  minimum: bigint;
  publicBalance: bigint;
  expiryBlock: bigint;
  currentBlock: bigint;
  recipient: bigint;
  conditionRecipient: bigint;
  amount: bigint;
  maxTransfer: bigint;
  proofTx: string;
}

export interface Verdict {
  decision: 'APPROVE' | 'REJECT';
  reasonCode: string;
}

function reject(reasonCode: string): Verdict {
  return { decision: 'REJECT', reasonCode };
}

export function decide(input: GatekeeperInput, alreadySeen: boolean): Verdict {
  if (alreadySeen) return reject('PROOF_REUSED');
  if (input.proofVk !== input.registeredVk) return reject('VK_SUBSTITUTION');
  if (input.publicBalance < input.minimum) return reject('THRESHOLD_MISMATCH');
  if (input.currentBlock >= input.expiryBlock) return reject('EXPIRED_CONDITION');
  if (input.recipient !== input.conditionRecipient) return reject('RECIPIENT_MISMATCH');
  if (input.amount > input.maxTransfer) return reject('AMOUNT_OVERFLOW');
  return { decision: 'APPROVE', reasonCode: 'VALID_CONDITION' };
}
