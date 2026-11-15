import { randomBytes } from 'node:crypto';
import { Config } from './config.js';
import { log } from './log.js';
import { decide, GatekeeperInput } from './checks.js';
import { MalformedInput, parseTaskInput, parseTimestamp } from './parse.js';
import { toCircuitInputs } from './encoding.js';
import { Prover } from './prover.js';
import { Kurier } from './kurier.js';
import { Store } from './storage.js';

export interface GatekeeperDeps {
  config: Config;
  store: Store;
  prover: Prover;
  kurier: Kurier;
  /** False only while the boot warm-up is still running. */
  isReady: () => boolean;
}

interface ResponseBody {
  decision: 'APPROVE' | 'REJECT';
  reason_code: string;
  proof?: unknown;
  public_signals?: string[];
  proof_tx?: string;
}

/** Minimum time we are willing to spend attempting a proof. */
const MIN_PROVE_MS = 3000;

/**
 * Task orchestrator. Pipeline and what is logged per task:
 *   task.received  -> warm-up gate + staleness checks
 *   task.checked   -> cached-answer lookup + claim + checks  [storeMs, checksMs]
 *   task.proven    -> snarkjs Groth16 proof                  [proveMs]
 *   task.kurier    -> submit + poll until Finalized          [kurierMs]
 *   task.answered  -> totals + remaining deadline            [totalMs]
 *
 * Fail-closed rules (per the event spec):
 *   - If we decided APPROVE but cannot attach a locally-verified,
 *     Kurier-finalized proof in time, we answer REJECT instead.
 *   - If the store (proof-reference memory) fails or times out, we answer
 *     REJECT STORE_UNAVAILABLE - never approve unverified.
 *   - Rejections never need a Kurier submission.
 */
export class Gatekeeper {
  /** Same task_id being answered concurrently waits for the same answer. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly deps: GatekeeperDeps) {}

  async handle(envelope: Record<string, unknown>): Promise<string> {
    // Boot gate: fail closed, signed, no crash while warm-up is running.
    if (!this.deps.isReady()) {
      log('task.warming_up_rejected');
      return this.bodyString({ decision: 'REJECT', reason_code: 'WARMING_UP' });
    }

    const taskId = typeof envelope.task_id === 'string' ? envelope.task_id : null;
    if (taskId === null) {
      log('task.malformed', { error: 'task_id missing' });
      return this.bodyString({ decision: 'REJECT', reason_code: 'MALFORMED_INPUT' });
    }
    const pending = this.inFlight.get(taskId);
    if (pending) return pending;

    const deadlineMs = parseTimestamp(envelope.deadline_at);
    const received = Date.now();
    const capMs =
      deadlineMs !== null
        ? Math.max(0, Math.min(this.deps.config.absoluteCapMs, deadlineMs - received - this.deps.config.deadlineMarginMs))
        : this.deps.config.absoluteCapMs;

    const work = this.answer(envelope, taskId, received, deadlineMs).catch((e) => {
      log('task.error', { taskId, error: safeMessage(e) });
      return this.bodyString({ decision: 'REJECT', reason_code: 'INTERNAL_ERROR' });
    });

    // Hard watchdog: whatever happens inside, respond before the deadline.
    const watchdog = sleep(capMs).then(() => {
      log('task.watchdog_fired', { taskId, capMs });
      return this.bodyString({ decision: 'REJECT', reason_code: 'TIMEOUT' });
    });
    const raced = Promise.race([work, watchdog]);
    const tracked = raced.finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, tracked);
    return tracked;
  }

  private async answer(
    envelope: Record<string, unknown>,
    taskId: string,
    received: number,
    deadlineMs: number | null,
  ): Promise<string> {
    const cfg = this.deps.config;
    const mode = envelope.mode;
    const rawInput = envelope.input;
    const proofTxEcho = (rawInput as Record<string, unknown> | null)?.proof_tx;
    const proofTx = typeof proofTxEcho === 'string' ? proofTxEcho : undefined;

    const withEcho = (body: ResponseBody): ResponseBody =>
      proofTx !== undefined ? { ...body, proof_tx: proofTx } : body;

    // Deadline already in the past on arrival -> stale, fail closed, no work.
    const now = Date.now();
    if (deadlineMs !== null && deadlineMs <= now) {
      log('task.stale', { taskId, mode });
      return this.bodyString(withEcho({ decision: 'REJECT', reason_code: 'STALE_TIMESTAMP' }));
    }

    // Platform retry: return the identical stored body (same task_id only -
    // the cache key IS the task_id, so nothing else can ever match it).
    let cached: string | null = null;
    let storeMs = 0;
    try {
      const t0 = Date.now();
      cached = await this.deps.store.getTaskResponse(taskId);
      storeMs += Date.now() - t0;
    } catch (e) {
      log('task.store_error', { taskId, op: 'getTaskResponse', error: safeMessage(e) });
      return this.bodyString(withEcho({ decision: 'REJECT', reason_code: 'STORE_UNAVAILABLE' }));
    }
    if (cached !== null) {
      log('task.retry', { taskId });
      return cached;
    }

    // Parse the task fields.
    let input: GatekeeperInput | null = null;
    try {
      input = parseTaskInput(rawInput);
    } catch (e) {
      if (!(e instanceof MalformedInput)) throw e;
      log('task.parse_error', { taskId, error: e.message });
    }

    // Atomically claim the proof reference for THIS task_id.
    //   NEW       -> first time seen, continue
    //   SAME_TASK -> a retry of the same task_id, NOT reuse, continue
    //   TAKEN     -> a different task_id used it already -> PROOF_REUSED
    let alreadySeen = false;
    if (input !== null) {
      try {
        const t0 = Date.now();
        const claim = await this.deps.store.claimProofRef(input.proofTx, taskId);
        storeMs += Date.now() - t0;
        if (claim === 'TAKEN') alreadySeen = true;
      } catch (e) {
        log('task.store_error', { taskId, op: 'claimProofRef', error: safeMessage(e) });
        // Fail closed: never approve when the store cannot confirm freshness.
        return this.bodyString(withEcho({ decision: 'REJECT', reason_code: 'STORE_UNAVAILABLE' }));
      }
    }

    const verdict = input === null
      ? { decision: 'REJECT' as const, reasonCode: 'MALFORMED_INPUT' }
      : decide(input, alreadySeen);
    log('task.checked', {
      taskId,
      mode,
      decision: verdict.decision,
      reasonCode: verdict.reasonCode,
      storeMs,
      checksMs: Date.now() - received,
    });

    // Provable = the circuit can witness this decision. PROOF_REUSED has no
    // proof to submit (official event page); malformed/stale have no inputs.
    const provable =
      input !== null &&
      verdict.reasonCode !== 'PROOF_REUSED' &&
      verdict.reasonCode !== 'MALFORMED_INPUT' &&
      verdict.reasonCode !== 'STALE_TIMESTAMP';

    let proof: unknown;
    let publicSignals: string[] | undefined;
    let proveMs = 0;

    if (provable && input !== null) {
      const remaining = remainingMs(deadlineMs, cfg);
      const budget = Math.min(cfg.proofBudgetMs, remaining);
      if (budget < MIN_PROVE_MS) {
        log('task.proof_skipped_no_budget', { taskId, budgetMs: budget });
        // Fail closed: an APPROVE without proof is not allowed to leave.
        if (verdict.decision === 'APPROVE') {
          return this.finish(taskId, withEcho({ decision: 'REJECT', reason_code: 'TIMEOUT' }), received, 0, 0, storeMs);
        }
        return this.finish(taskId, withEcho({ decision: 'REJECT', reason_code: verdict.reasonCode }), received, 0, 0, storeMs);
      }
      try {
        const salt = BigInt(`0x${randomBytes(31).toString('hex')}`);
        const result = await this.deps.prover.prove(
          toCircuitInputs(input, taskId, verdict.decision === 'APPROVE' ? 1 : 0, salt, cfg.taskIdEncoding),
        );
        proveMs = result.proveMs;
        log('task.proven', { taskId, proveMs, locallyVerified: result.locallyVerified });
        proof = result.proof;
        publicSignals = result.publicSignals;
      } catch (e) {
        log('task.proof_failed', { taskId, error: safeMessage(e) });
        // The circuit asserts decision == its own evaluation, so an APPROVE
        // proof failure means our decision itself is in doubt -> fail closed.
        if (verdict.decision === 'APPROVE') {
          return this.finish(taskId, withEcho({ decision: 'REJECT', reason_code: 'PROOF_FAILED' }), received, proveMs, 0, storeMs);
        }
        // A rejected trap without a proof still records the correct decision.
        return this.finish(taskId, withEcho({ decision: 'REJECT', reason_code: verdict.reasonCode }), received, proveMs, 0, storeMs);
      }
    }

    // APPROVE must reach "Finalized" on zkVerify before leaving (checklist).
    if (verdict.decision === 'APPROVE' && proof !== undefined && !cfg.skipKurier) {
      const remaining = remainingMs(deadlineMs, cfg);
      const kurierBudget = Math.min(cfg.kurierBudgetMs, Math.max(0, remaining - proveMs));
      const result = await this.deps.kurier.submitAndWait(proof, publicSignals ?? [], kurierBudget);
      log('task.kurier', { taskId, ok: result.ok, status: result.status, kurierMs: result.ms });
      if (!result.ok) {
        // Fail closed: no finalized verification, no approval.
        return this.finish(
          taskId,
          withEcho({ decision: 'REJECT', reason_code: result.status === 'NO_API_KEY' ? 'PROOF_FAILED' : 'TIMEOUT' }),
          received,
          proveMs,
          result.ms,
          storeMs,
        );
      }
    } else if (verdict.decision === 'APPROVE' && proof !== undefined && cfg.skipKurier) {
      log('task.kurier_skipped_dev', { taskId });
    }

    const body: ResponseBody = {
      decision: verdict.decision,
      reason_code: verdict.reasonCode,
    };
    if (proof !== undefined) {
      body.proof = proof;
      body.public_signals = publicSignals;
    }
    return this.finish(taskId, withEcho(body), received, proveMs, 0, storeMs);
  }

  /** Caches the response for platform retries and returns the JSON string. */
  private finish(
    taskId: string,
    body: ResponseBody,
    received: number,
    proveMs: number,
    kurierMs: number,
    storeMs: number,
  ): string {
    const text = this.bodyString(body);
    // Cache write-back is best-effort: the claim (the security-critical part)
    // already succeeded. If this fails, a retry re-decides deterministically.
    this.deps.store.setTaskResponse(taskId, text).catch((e) => {
      log('task.store_error', { taskId, op: 'setTaskResponse', error: safeMessage(e) });
    });
    log('task.answered', {
      taskId,
      decision: body.decision,
      reasonCode: body.reason_code,
      proofAttached: body.proof !== undefined,
      storeMs,
      checksMs: Math.max(0, Date.now() - received - proveMs - kurierMs - storeMs),
      proveMs,
      kurierMs,
      totalMs: Date.now() - received,
    });
    return text;
  }

  private bodyString(body: ResponseBody): string {
    return JSON.stringify(body);
  }
}

function remainingMs(deadlineMs: number | null, cfg: Config): number {
  // Budget left inside our absolute cap and inside the platform deadline.
  const byDeadline = deadlineMs !== null ? deadlineMs - Date.now() - cfg.deadlineMarginMs : cfg.absoluteCapMs;
  return Math.max(0, Math.min(cfg.absoluteCapMs, byDeadline));
}

function safeMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
