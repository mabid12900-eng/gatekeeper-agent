/**
 * Storage for the two things we must remember between tasks:
 *
 *   1. proof references (proof_tx) that a task_id has already claimed, so a
 *      DIFFERENT task_id re-using the same reference is detected (PROOF_REUSED),
 *      while a platform RETRY of the SAME task_id is not.
 *   2. each answered task's response body, so a retry of the same task_id gets
 *      the identical decision quickly instead of redoing proof generation.
 *
 * Both implementations are behind the same `Store` interface, so swapping is a
 * one-line change in src/server.ts.
 *
 * SECURITY / FAIL-CLOSED CONTRACT:
 *   - `claimProofRef` must be ATOMIC ("set if not exists") so two concurrent
 *     tasks cannot both slip through.
 *   - Any store failure (timeout, unexpected answer) is surfaced as a thrown
 *     error; the caller rejects with STORE_UNAVAILABLE. We never approve when
 *     the store cannot confirm a reference is unused.
 *   - RedisStore never logs the REST token or the full URL.
 */

/** Result of atomically claiming a proof reference for a task. */
export type ClaimResult =
  /** Nobody had claimed it before; this task now owns it. */
  | 'NEW'
  /** The SAME task_id claimed it earlier (a platform retry) - NOT reuse. */
  | 'SAME_TASK'
  /** A DIFFERENT task_id claimed it earlier - PROOF_REUSED. */
  | 'TAKEN';

export interface Store {
  claimProofRef(proofRef: string, taskId: string): Promise<ClaimResult>;
  getTaskResponse(taskId: string): Promise<string | null>;
  setTaskResponse(taskId: string, body: string): Promise<void>;
}

/** ~30 days, matching the proof-reference TTL. */
const PROOF_REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** ~24 hours for cached answers. */
const TASK_RESPONSE_TTL_MS = 24 * 60 * 60 * 1000;

/** Bounded in-memory fallback: flat RAM on a 512 MB free plan, but state is
 *  LOST on restart. Used only when the Upstash variables are not configured. */
export class MemoryStore implements Store {
  private proofRefs = new Map<string, { taskId: string; expiresAt: number }>();
  private tasks = new Map<string, { body: string; expiresAt: number }>();

  constructor(private readonly maxEntries: number) {}

  async claimProofRef(proofRef: string, taskId: string): Promise<ClaimResult> {
    // Single-threaded event loop: this check-then-set is effectively atomic.
    const now = Date.now();
    const existing = this.proofRefs.get(proofRef);
    if (existing && existing.expiresAt > now) {
      return existing.taskId === taskId ? 'SAME_TASK' : 'TAKEN';
    }
    this.proofRefs.set(proofRef, { taskId, expiresAt: now + PROOF_REF_TTL_MS });
    if (this.proofRefs.size > this.maxEntries) {
      const oldest = this.proofRefs.keys().next().value;
      if (oldest !== undefined) this.proofRefs.delete(oldest);
    }
    return 'NEW';
  }

  async getTaskResponse(taskId: string): Promise<string | null> {
    const entry = this.tasks.get(taskId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.tasks.delete(taskId);
      return null;
    }
    return entry.body;
  }

  async setTaskResponse(taskId: string, body: string): Promise<void> {
    this.tasks.set(taskId, { body, expiresAt: Date.now() + TASK_RESPONSE_TTL_MS });
    if (this.tasks.size > this.maxEntries) {
      const oldest = this.tasks.keys().next().value;
      if (oldest !== undefined) this.tasks.delete(oldest);
    }
  }
}

/** ~30 days in seconds for the Redis SET EX. */
const PROOF_REF_TTL_SECONDS = 30 * 24 * 60 * 60;
/** ~24 hours in seconds for cached answers. */
const TASK_RESPONSE_TTL_SECONDS = 24 * 60 * 60;
/** Short timeout for EVERY Redis call. */
const REDIS_TIMEOUT_MS = 3000;

/**
 * Redis-backed store using Upstash's REST API (plain fetch, no SDK).
 *   SET key value NX EX <ttl>  -> atomic "set if not exists"
 *   GET key                    -> who owns it, if anyone
 * Every call: 3 s timeout, at most one retry, then throw (caller fails closed).
 */
export class RedisStore implements Store {
  private readonly url: string;
  private readonly token: string;

  constructor(rawUrl: string, token: string) {
    // Strip a trailing slash so `${url}` joins cleanly; nothing else is stored.
    this.url = rawUrl.replace(/\/+$/, '');
    this.token = token;
  }

  /** Error text with the URL scrubbed out, so logs never leak configuration. */
  private safeError(e: unknown): string {
    return String(e instanceof Error ? e.message : e).split(this.url).join('<redis-url>');
  }

  /** One Redis command: at most two attempts (initial + one retry). */
  private async command(args: (string | number)[]): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`redis http ${res.status}`);
        const body = (await res.json()) as { result?: unknown; error?: unknown };
        if (body.error !== undefined && body.error !== null) {
          throw new Error(`redis error: ${String(body.error)}`);
        }
        return body.result;
      } catch (e) {
        lastError = e;
        if (attempt === 1) break;
      }
    }
    throw new Error(`redis command failed: ${this.safeError(lastError)}`);
  }

  async claimProofRef(proofRef: string, taskId: string): Promise<ClaimResult> {
    const key = `gk:ref:${proofRef}`;
    // Atomic claim: only ONE concurrent task can turn this into "OK".
    const first = await this.command(['SET', key, taskId, 'NX', 'EX', PROOF_REF_TTL_SECONDS]);
    if (first === 'OK') return 'NEW';
    // Lost the race - find out who holds the reference.
    const owner = await this.command(['GET', key]);
    if (owner === taskId) return 'SAME_TASK';
    if (typeof owner === 'string') return 'TAKEN';
    // owner === null: the key expired between our SET and GET. Try once more;
    // if that also fails the state is genuinely unexpected -> fail closed.
    const retry = await this.command(['SET', key, taskId, 'NX', 'EX', PROOF_REF_TTL_SECONDS]);
    if (retry === 'OK') return 'NEW';
    throw new Error('redis claim: unexpected state after re-set');
  }

  async getTaskResponse(taskId: string): Promise<string | null> {
    const result = await this.command(['GET', `gk:ans:${taskId}`]);
    if (result === null || result === undefined) return null;
    if (typeof result === 'string') return result;
    throw new Error('redis getTaskResponse: unexpected result type');
  }

  async setTaskResponse(taskId: string, body: string): Promise<void> {
    await this.command(['SET', `gk:ans:${taskId}`, body, 'EX', TASK_RESPONSE_TTL_SECONDS]);
  }
}
