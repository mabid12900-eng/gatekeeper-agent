import { keccak_256 } from '@noble/hashes/sha3.js';
import { createHash } from 'node:crypto';
import { TaskIdEncoding } from './config.js';
import { GatekeeperInput } from './checks.js';

/**
 * Circuit input mapping for the official gatekeeper circuit
 * (gatekeeper.wasm / gatekeeper_final.zkey).
 *
 * Signal names and the public-signal layout were confirmed by probing the
 * real artifacts: the circuit has exactly 13 inputs, 13 public signals, and
 * it ASSERTS that `decision` equals its own evaluation of the checks
 * (a proof can only exist when the decision is honest).
 *
 * The one UNCONFIRMED mapping is how the text `task_id` ("gk_...") becomes
 * the circuit's numeric `taskId`. Use TASK_ID_ENCODING to switch schemes
 * after observing a practice task; no code change needed.
 */
export const BN254_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const mod = (x: bigint): bigint => ((x % BN254_P) + BN254_P) % BN254_P;

export function taskIdToField(taskId: string, encoding: TaskIdEncoding): bigint {
  switch (encoding) {
    case 'keccak': {
      const digest = keccak_256(Buffer.from(taskId, 'utf8'));
      return mod(BigInt('0x' + Buffer.from(digest).toString('hex')));
    }
    case 'sha256': {
      const digest = createHash('sha256').update(taskId, 'utf8').digest();
      return mod(BigInt('0x' + digest.toString('hex')));
    }
    case 'ascii': {
      const bytes = Buffer.from(taskId, 'utf8');
      return bytes.length === 0 ? 0n : mod(BigInt('0x' + bytes.toString('hex')));
    }
    case 'hex-digits': {
      const digits = taskId.replace(/^gk_/, '').replace(/[^0-9a-fA-F]/g, '');
      return digits === '' ? 0n : mod(BigInt('0x' + digits));
    }
  }
}

export type DecisionBit = 0 | 1;

/** All values as decimal strings, as snarkjs fullProve expects. */
export function toCircuitInputs(
  input: GatekeeperInput,
  taskId: string,
  decision: DecisionBit,
  salt: bigint,
  encoding: TaskIdEncoding,
): Record<string, string> {
  const f = (x: bigint) => mod(x).toString();
  return {
    minimum: f(input.minimum),
    publicBalance: f(input.publicBalance),
    amount: f(input.amount),
    maxTransfer: f(input.maxTransfer),
    recipient: f(input.recipient),
    conditionRecipient: f(input.conditionRecipient),
    expiryBlock: f(input.expiryBlock),
    currentBlock: f(input.currentBlock),
    taskId: f(taskIdToField(taskId, encoding)),
    salt: f(salt),
    decision: String(decision),
    registeredVkHash: f(input.registeredVk),
    proofVkHash: f(input.proofVk),
  };
}
