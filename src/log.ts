/**
 * Minimal structured logger.
 *
 * SECURITY: never pass secrets, API keys, or the HMAC secret here.
 * Callers must only pass safe fields (ids, statuses, timings).
 */
export function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}
