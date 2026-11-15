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
  circuits: { wasm: string; zkey: string; vk: string };
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

  return {
    port: positiveInt('PORT', 3000),
    hmacSecret: process.env.AGENT_GAMES_HMAC_SECRET || null,
    kurierApiKey: process.env.KURIER_API_KEY || null,
    kurierApiUrl: process.env.KURIER_API_URL || 'https://api.kurier.xyz/api/v1',
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
    upstashRestUrl: process.env.UPSTASH_REDIS_REST_URL || null,
    upstashRestToken: process.env.UPSTASH_REDIS_REST_TOKEN || null,
    skipKurier,
    isProduction,
    circuits: {
      wasm: process.env.CIRCUIT_WASM || 'circuits/gatekeeper.wasm',
      zkey: process.env.CIRCUIT_ZKEY || 'circuits/gatekeeper_final.zkey',
      vk: process.env.CIRCUIT_VK || 'circuits/gatekeeper_vk.json',
    },
  };
}
