import { Config } from './config.js';
import { log } from './log.js';

export interface KurierResult {
  ok: boolean;
  status: string;
  txHash: string | null;
  ms: number;
}

/**
 * Kurier REST workflow (official docs: https://docs.zkverify.io):
 *   POST {apiUrl}/submit-proof/{apiKey}   -> { jobId, optimisticVerify }
 *   GET  {apiUrl}/job-status/{apiKey}/{jobId} -> { status, txHash }
 * Poll until status "Finalized" ("Failed" is final too).
 *
 * SECURITY: the API key is part of the URL path. We therefore never log the
 * URL - only job ids and statuses. Every error text is scrubbed with
 * `scrubKurierSecrets` before it reaches a log line, because Node's fetch
 * errors (e.g. "Failed to parse URL from ...") can embed the FULL URL,
 * key included.
 */

/**
 * Removes the Kurier API key and the full API URL from any text destined for
 * logs. Order matters: the key first (it sits inside the URL), then the URL.
 * Returns the text unchanged only if neither appears in it.
 */
export function scrubKurierSecrets(text: string, apiKey: string | null, apiUrl: string): string {
  let scrubbed = text;
  if (apiKey !== null && apiKey !== '') {
    scrubbed = scrubbed.split(apiKey).join('<kurier-key>');
  }
  if (apiUrl !== '') {
    scrubbed = scrubbed.split(apiUrl).join('<kurier-url>');
  }
  return scrubbed;
}

/** Scrubs an unknown error/exception value down to safe log text. */
export function scrubKurierError(e: unknown, apiKey: string | null, apiUrl: string): string {
  return scrubKurierSecrets(e instanceof Error ? e.message : String(e), apiKey, apiUrl);
}

export class Kurier {
  constructor(private readonly config: Config) {}

  get available(): boolean {
    return this.config.kurierApiKey !== null;
  }

  async submitAndWait(
    proof: unknown,
    publicSignals: string[],
    budgetMs: number,
  ): Promise<KurierResult> {
    const t0 = Date.now();
    const apiKey = this.config.kurierApiKey;
    if (!apiKey) return { ok: false, status: 'NO_API_KEY', txHash: null, ms: 0 };
    if (budgetMs <= 2000) return { ok: false, status: 'NO_BUDGET', txHash: null, ms: 0 };

    let jobId: string | null = null;
    try {
      const submitRes = await fetch(
        `${this.config.kurierApiUrl}/submit-proof/${apiKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            proofType: 'groth16',
            vkRegistered: true,
            proofOptions: { library: 'snarkjs', curve: 'bn128' },
            proofData: {
              proof,
              publicSignals,
              vk: this.config.gatekeeperVkHash,
            },
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      const submitBody = (await submitRes.json()) as Record<string, unknown>;
      jobId = typeof submitBody.jobId === 'string' ? submitBody.jobId : null;
      if (!submitRes.ok || !jobId) {
        log('kurier.submit_failed', { httpStatus: submitRes.status });
        return { ok: false, status: `HTTP_${submitRes.status}`, txHash: null, ms: Date.now() - t0 };
      }
      if (submitBody.optimisticVerify !== 'success') {
        log('kurier.optimistic_not_success', {
          jobId,
          optimisticVerify: scrubKurierSecrets(String(submitBody.optimisticVerify), apiKey, this.config.kurierApiUrl),
        });
        return {
          ok: false,
          status: `OPTIMISTIC_${String(submitBody.optimisticVerify)}`,
          txHash: null,
          ms: Date.now() - t0,
        };
      }
      log('kurier.submitted', { jobId });

      for (;;) {
        const elapsed = Date.now() - t0;
        if (elapsed >= budgetMs) {
          log('kurier.budget_exceeded', { jobId, ms: elapsed });
          return { ok: false, status: 'BUDGET_EXCEEDED', txHash: null, ms: elapsed };
        }
        const statusRes = await fetch(
          `${this.config.kurierApiUrl}/job-status/${apiKey}/${jobId}`,
          { signal: AbortSignal.timeout(10000) },
        );
        const statusBody = (await statusRes.json()) as Record<string, unknown>;
        const status = typeof statusBody.status === 'string' ? statusBody.status : 'UNKNOWN';
        log('kurier.status', {
          jobId,
          status: scrubKurierSecrets(status, apiKey, this.config.kurierApiUrl),
        });
        if (status === 'Finalized') {
          return {
            ok: true,
            status,
            txHash: typeof statusBody.txHash === 'string' ? statusBody.txHash : null,
            ms: Date.now() - t0,
          };
        }
        if (status === 'Failed') {
          return { ok: false, status, txHash: null, ms: Date.now() - t0 };
        }
        const remaining = budgetMs - (Date.now() - t0);
        await sleep(Math.max(0, Math.min(this.config.kurierPollMs, remaining)));
      }
    } catch (e) {
      log('kurier.error', { jobId, error: scrubKurierError(e, apiKey, this.config.kurierApiUrl) });
      return { ok: false, status: 'ERROR', txHash: null, ms: Date.now() - t0 };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
