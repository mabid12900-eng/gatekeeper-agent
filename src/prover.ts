import * as snarkjs from 'snarkjs';
import fs from 'node:fs';
import { Config } from './config.js';
import { log } from './log.js';

export interface ProofResult {
  proof: unknown;
  publicSignals: string[];
  proveMs: number;
  locallyVerified: boolean;
}

/**
 * Local Groth16 prover. The .wasm/.zkey/.vk files are the official artifacts
 * from https://agentgames.zkverify.io/circuits/ (committed to the repo).
 *
 * Memory note: the zkey is ~0.3 MB and is read from disk per proof (cheap,
 * page-cached by the OS); the verification key JSON is loaded once and kept
 * in memory. Peak RSS stays far below a 512 MB free plan.
 */
export class Prover {
  private readonly vk: Record<string, unknown>;

  constructor(private readonly config: Config) {
    this.vk = JSON.parse(fs.readFileSync(config.circuits.vk, 'utf8'));
  }

  /**
   * Generates the proof and verifies it locally before we trust it.
   * Throws when the witness cannot be built (which for this circuit means
   * the decision does not match the checks - never ignored silently).
   */
  async prove(inputs: Record<string, string>): Promise<ProofResult> {
    const t0 = Date.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      inputs,
      this.config.circuits.wasm,
      this.config.circuits.zkey,
    );
    const proveMs = Date.now() - t0;
    const locallyVerified = await snarkjs.groth16.verify(
      this.vk,
      publicSignals,
      proof,
    );
    if (!locallyVerified) throw new Error('local verification failed');
    return { proof, publicSignals, proveMs, locallyVerified: true };
  }

  /**
   * One throwaway proof at startup: fails fast (with a log line, not a crash)
   * if the artifacts or the environment are broken, and warms snarkjs so the
   * first real task is not slowed by cold initialization.
   */
  async warmUp(): Promise<void> {
    const t0 = Date.now();
    try {
      const result = await this.prove({
        minimum: '1000',
        publicBalance: '1460',
        amount: '500',
        maxTransfer: '1000',
        recipient: '111',
        conditionRecipient: '111',
        expiryBlock: '19842201',
        currentBlock: '19832000',
        taskId: '42',
        salt: '7',
        decision: '1',
        registeredVkHash: '999',
        proofVkHash: '999',
      });
      log('prover.warmup_ok', { ms: Date.now() - t0, proveMs: result.proveMs });
    } catch (e) {
      log('prover.warmup_failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
