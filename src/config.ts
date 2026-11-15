import 'dotenv/config';

export type TaskIdEncoding = 'keccak' | 'sha256' | 'ascii' | 'hex-digits';

const TASK_ID_ENCODINGS: TaskIdEncoding[] = ['keccak', 'sha256', 'ascii', 'hex-digits'];

export interface Config {
  port: number;
  /** Platform-generated HMAC secret ("Rotate Secret" on the dashboard). */
  hmacSecret: string | null;
  /** Kurier API key (mainnet or testnet). */
  kurierApiKey: string | null;
  kurierApiUrl: string;
  /** vk_hash of the official gatekeeper circuit, registered on zkVerify mainnet. */
  gatekeeperVkHash: string;
  taskIdEncoding: TaskIdEncoding;
  proofBudgetMs: number;
  kurierBudgetMs: number;
  deadlineMarginMs: number;
  kurierPollMs: number;
  absoluteCapMs: number;
  maxStoreEntries: number;
  /** Upstash Redis REST credentials. Both set -> Redis is REQUIRED (fail closed). */
  upstashRestUrl: string | null;
  upstashRestToken: string | null;
  /** Dev-only: answer APPROVE without Kurier. Ignored in production. */
  skipKurier: boolean;
  isProduction: boolean;
  /**
   * Production startup validation: variable NAMES (never values) of required
   * configuration that is missing or looks like a placeholder. In production
   * a non-empty list makes /agent fail closed (503) while /health stays up.
   */
  problems: string[];
  /** Only-logged issues that do not block service (names only). */
  warnings: string[];
  circuits: { wasm: string; zkey: string; vk: string };
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Conservative placeholder detector for secrets: flags only obvious
 * non-values (empty, "<...>" templates, changeme/placeholder-style words).
 * A real platform-generated secret will never look like these.
 */
function looksLikePlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === '') return true;
  if (v.startsWith('<') && v.endsWith('>')) return true;
  const placeholders = new Set([
    'changeme', 'change-me', 'placeholder', 'your-secret', 'your-secret-here',
    'your-api-key', 'dummy', 'example', 'tobefilled', 'to-be-filled', 'todo', 'none',
  ]);
  return placeholders.has(v);
}

export function loadConfig(): Config {
  const isProduction = process.env.NODE_ENV === 'production';

  // Dev-only convenience. Hard-ignored in production so it can never weaken
  // the deployed agent, even by accident.
  const skipKurier = !isProduction && process.env.SKIP_KURIER === '1';
  if (skipKurier) {
    console.log('WARNING: SKIP_KURIER=1 - APPROVE responses will NOT be submitted to Kurier. Dev/local only.');
  }

  const encodingRaw = process.env.TASK_ID_ENCODING;
  const taskIdEncoding: TaskIdEncoding =
    encodingRaw && (TASK_ID_ENCODINGS as string[]).includes(encodingRaw)
      ? (encodingRaw as TaskIdEncoding)
      : 'keccak';

  const hmacSecret = process.env.AGENT_GAMES_HMAC_SECRET || null;
  const kurierApiKey = process.env.KURIER_API_KEY || null;
  const kurierApiUrl = process.env.KURIER_API_URL || 'https://api.kurier.xyz/api/v1';
  const upstashRestUrl = process.env.UPSTASH_REDIS_REST_URL || null;
  const upstashRestToken = process.env.UPSTASH_REDIS_REST_TOKEN || null;

  // ---- startup validation (names only, never values) -----------------------
  const problems: string[] = [];
  const warnings: string[] = [];

  if (hmacSecret === null) problems.push('AGENT_GAMES_HMAC_SECRET is not set');
  else if (looksLikePlaceholder(hmacSecret)) problems.push('AGENT_GAMES_HMAC_SECRET looks like a placeholder');

  if (kurierApiKey === null) problems.push('KURIER_API_KEY is not set');
  else if (looksLikePlaceholder(kurierApiKey)) problems.push('KURIER_API_KEY looks like a placeholder');

  if (!kurierApiUrl.startsWith('https://')) {
    problems.push('KURIER_API_URL must start with https://');
  }
  if (process.env.KURIER_API_URL === undefined || process.env.KURIER_API_URL === '') {
    warnings.push('KURIER_API_URL not set - using the built-in competition default (mainnet)');
  }
  if (isProduction && kurierApiUrl.includes('testnet')) {
    warnings.push('KURIER_API_URL points to TESTNET while NODE_ENV is production - competition proofs must go to mainnet');
  }

  if (upstashRestUrl === null && upstashRestToken === null) {
    warnings.push('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set - in-memory store loses state on restart');
  } else if (upstashRestUrl === null || upstashRestToken === null) {
    problems.push('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together');
  }

  // In non-production (local dev, tests) configuration problems never block
  // serving; they are only printed. Production gates /agent on them.
  const effectiveProblems = isProduction ? problems : [];

  for (const problem of problems) {
    console.log(`CONFIG ERROR: ${problem}`);
  }
  if (isProduction && problems.length > 0) {
    console.log(`CONFIG ERROR: ${problems.length} configuration problem(s) - /agent will fail closed (503) until fixed. /health stays up.`);
  }
  for (const warning of warnings) {
    console.log(`CONFIG WARNING: ${warning}`);
  }

  return {
    port: positiveInt('PORT', 3000),
    hmacSecret,
    kurierApiKey,
    kurierApiUrl,
    gatekeeperVkHash:
      process.env.GATEKEEPER_VK_HASH ||
      '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
    taskIdEncoding,
    proofBudgetMs: positiveInt('PROOF_BUDGET_MS', 20000),
    kurierBudgetMs: positiveInt('KURIER_BUDGET_MS', 25000),
    deadlineMarginMs: positiveInt('DEADLINE_MARGIN_MS', 6000),
    kurierPollMs: positiveInt('KURIER_POLL_MS', 2000),
    absoluteCapMs: positiveInt('ABSOLUTE_CAP_MS', 52000),
    maxStoreEntries: positiveInt('MAX_STORE_ENTRIES', 20000),
    upstashRestUrl,
    upstashRestToken,
    skipKurier,
    isProduction,
    problems: effectiveProblems,
    warnings,
    circuits: {
      wasm: process.env.CIRCUIT_WASM || 'circuits/gatekeeper.wasm',
      zkey: process.env.CIRCUIT_ZKEY || 'circuits/gatekeeper_final.zkey',
      vk: process.env.CIRCUIT_VK || 'circuits/gatekeeper_vk.json',
    },
  };
}
