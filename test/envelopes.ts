import { sign } from '../src/hmac.js';

/**
 * Sample task envelopes for the local test harness.
 * Field values follow the official sample payload from
 * https://agentgames.zkverify.io/build and the event page.
 */

export const TEST_SECRET = 'local-test-secret-not-a-real-secret';

const FUTURE = () => new Date(Date.now() + 45_000).toISOString();

export interface EnvelopeOverrides {
  task_id?: string;
  mode?: string;
  issued_at?: string;
  deadline_at?: string;
  input?: Partial<{
    registered_vk: string;
    proof_vk: string;
    minimum: string;
    public_balance: string;
    expiry_block: number;
    current_block: number;
    recipient: string;
    condition_recipient: string;
    amount: string;
    max_transfer: string;
    proof_tx: string;
  }>;
}

/** A VALID condition (should APPROVE) - the official sample values. */
export function validEnvelope(overrides: EnvelopeOverrides = {}): Record<string, unknown> {
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: overrides.task_id ?? `gk_test_${Math.random().toString(16).slice(2)}`,
    mode: overrides.mode ?? 'practice',
    issued_at: overrides.issued_at ?? new Date().toISOString(),
    deadline_at: overrides.deadline_at ?? FUTURE(),
    input: {
      registered_vk: '0x7d3a00000000000000000000000000000000000000000000000000000000f291',
      proof_vk: '0x7d3a00000000000000000000000000000000000000000000000000000000f291',
      minimum: '1000',
      public_balance: '1460',
      expiry_block: 99999999,
      current_block: 99000000,
      recipient: '0xDe420000000000000000000000000000000009f01',
      condition_recipient: '0xDe420000000000000000000000000000000009f01',
      amount: '500',
      max_transfer: '1000',
      // Every real task carries a unique proof reference; so does every
      // generated test envelope (override only for the reuse test).
      proof_tx: `0xa4c1${Math.random().toString(16).slice(2).padEnd(12, '0')}`,
      ...overrides.input,
    },
  };
}

export function preflightEnvelope(): Record<string, unknown> {
  return {
    type: 'agent-games.preflight.v1',
    agent_id: 'agt_test',
    issued_at: new Date().toISOString(),
    nonce: 'test-nonce',
  };
}

/** Serializes and signs exactly the way the platform is expected to. */
export function signedRequest(
  secret: string,
  envelope: Record<string, unknown>,
): { body: string; signature: string } {
  const body = JSON.stringify(envelope);
  return { body, signature: sign(Buffer.from(secret, 'utf8'), body) };
}
