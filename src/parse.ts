import { GatekeeperInput } from './checks.js';

/** Thrown when a signed envelope's fields cannot be parsed. */
export class MalformedInput extends Error {}

/**
 * Parse timestamps tolerantly: ISO 8601 strings, epoch seconds, or epoch ms.
 * Returns null when missing or unparsable (callers decide what that means).
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value !== '') {
    if (/^\d+$/.test(value)) {
      const n = Number(value);
      return n > 1e12 ? n : n * 1000;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Parse the task `input` object into bigints (accepts decimal strings, hex strings, numbers). */
export function parseTaskInput(raw: unknown): GatekeeperInput {
  if (raw === null || typeof raw !== 'object') throw new MalformedInput('input missing');
  const obj = raw as Record<string, unknown>;

  const field = (value: unknown, name: string): bigint => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === 'string' && value !== '') {
      if (/^-?\d+$/.test(value)) return BigInt(value);
      if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
    }
    throw new MalformedInput(`bad field ${name}`);
  };
  const text = (value: unknown, name: string): string => {
    if (typeof value === 'string' && value !== '') return value;
    throw new MalformedInput(`bad field ${name}`);
  };

  return {
    registeredVk: field(obj.registered_vk, 'registered_vk'),
    proofVk: field(obj.proof_vk, 'proof_vk'),
    minimum: field(obj.minimum, 'minimum'),
    publicBalance: field(obj.public_balance, 'public_balance'),
    expiryBlock: field(obj.expiry_block, 'expiry_block'),
    currentBlock: field(obj.current_block, 'current_block'),
    recipient: field(obj.recipient, 'recipient'),
    conditionRecipient: field(obj.condition_recipient, 'condition_recipient'),
    amount: field(obj.amount, 'amount'),
    maxTransfer: field(obj.max_transfer, 'max_transfer'),
    proofTx: text(obj.proof_tx, 'proof_tx'),
  };
}
