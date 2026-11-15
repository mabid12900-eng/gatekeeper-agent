import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { loadConfig, Config } from './config.js';
import { SIGNATURE_HEADER, candidateKeys, sign, verify } from './hmac.js';
import { Gatekeeper } from './gatekeeper.js';
import { Kurier } from './kurier.js';
import { Prover } from './prover.js';
import { MemoryStore, RedisStore, Store } from './storage.js';
import { log } from './log.js';

/**
 * Public HTTPS service, hardened for Render's free plan (sleeps, restarts,
 * no permanent disk, ~512 MB RAM):
 *
 *   GET  /health -> "ok"   (public, instant, touches NO store/prover/Kurier;
 *                           safe to ping every 5 minutes by uptime monitors)
 *   POST /agent  -> signed tasks (HMAC-verified BEFORE parsing; the full
 *                           handler path "/agent" is what gets registered)
 *
 * The server listens on 0.0.0.0 and on Render's PORT variable.
 * SIGTERM/SIGINT stop new requests, let in-flight ones finish (up to ~20 s),
 * then exit cleanly.
 */

// Shared in-flight request counter (middleware increments, shutdown reads it).
let inflightCount = 0;

export function createApp(depsOverride?: {
  store?: Store;
  warmUp?: () => Promise<void>;
}) {
  const config: Config = loadConfig();
  if (!config.hmacSecret) {
    console.log('WARNING: AGENT_GAMES_HMAC_SECRET is not set. /health works, but every /agent request will be rejected.');
  }

  // Store selection: Upstash Redis when BOTH variables are set, otherwise the
  // in-memory fallback with a loud warning (state is lost on restart).
  const store: Store =
    depsOverride?.store ??
    (config.upstashRestUrl !== null && config.upstashRestToken !== null
      ? new RedisStore(config.upstashRestUrl, config.upstashRestToken)
      : (console.log(
          'WARNING: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are NOT set - using the in-memory store. ' +
            'Render restarts will LOSE seen proof references and cached answers.',
        ),
        new MemoryStore(config.maxStoreEntries)));

  const prover = new Prover(config);
  const kurier = new Kurier(config);

  // Warm-up gate: tasks arriving before warm-up finishes get a signed,
  // fail-closed REJECT (WARMING_UP) instead of a crash.
  const ready = { value: false };
  const gatekeeper = new Gatekeeper({ config, store, prover, kurier, isReady: () => ready.value });
  const keys = config.hmacSecret ? candidateKeys(config.hmacSecret) : [];

  /** Starts boot warm-up; flips ready=true when done (even if it failed). */
  function beginWarmUp(): Promise<void> {
    const t0 = Date.now();
    const fn = depsOverride?.warmUp ?? ((): Promise<void> => prover.warmUp());
    return fn().then(
      () => {
        ready.value = true;
        log('server.ready', { warmUpMs: Date.now() - t0 });
      },
      () => {
        // Warm-up failure does not block serving: each task still fails
        // closed on its own if proving is genuinely broken.
        ready.value = true;
        log('server.ready', { warmUpMs: Date.now() - t0, warmUpFailed: true });
      },
    );
  }

  const app = express();
  // Raw-body-only parsing: HMAC must cover the exact bytes the platform sent.
  app.use(express.raw({ type: '*/*', limit: '256kb' }));

  app.use((_req, res, next) => {
    inflightCount++;
    res.on('close', () => {
      inflightCount--;
    });
    next();
  });

  app.get('/health', (_req, res) => {
    // Intentionally does nothing but this: no Redis, no prover, no Kurier.
    res.status(200).type('text/plain').send('ok');
  });

  app.post('/agent', (req, res) => {
    handleAgent(req, res, { keys, gatekeeper, ready }).catch((e) => {
      log('http.error', { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) res.status(500).type('application/json').send('{"error":"internal"}');
    });
  });

  return { app, config, prover, store, beginWarmUp, ready };
}

interface AgentDeps {
  keys: Buffer[];
  gatekeeper: Gatekeeper;
  ready: { value: boolean };
}

async function handleAgent(
  req: express.Request,
  res: express.Response,
  deps: AgentDeps,
): Promise<void> {
  const received = Date.now();
  const rawBody = req.body as Buffer;

  // 1. HMAC over the RAW body, BEFORE any parsing.
  const key = verify(deps.keys, rawBody, req.header(SIGNATURE_HEADER));
  if (key === null) {
    log('http.unauthorized', { path: '/agent' });
    res.status(401).type('application/json').send('{"error":"invalid signature"}');
    return;
  }

  // 2. Boot gate: signed, fail-closed REJECT while warm-up is still running.
  if (!deps.ready.value) {
    log('http.rejected_while_warming_up');
    sendSigned(res, 200, JSON.stringify({ decision: 'REJECT', reason_code: 'WARMING_UP' }), key);
    return;
  }

  // 3. Parse only after the signature checks out.
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody.toString('utf8'));
  } catch {
    const body = JSON.stringify({ decision: 'REJECT', reason_code: 'MALFORMED_INPUT' });
    sendSigned(res, 200, body, key);
    return;
  }

  // 4. Preflight handshake.
  if (envelope.type === 'agent-games.preflight.v1') {
    log('preflight.received', {
      agentId: typeof envelope.agent_id === 'string' ? envelope.agent_id : null,
      ms: Date.now() - received,
    });
    const body = JSON.stringify({ ok: true, protocolVersion: 'v1' });
    sendSigned(res, 200, body, key);
    return;
  }

  // 5. Proof Gatekeeper task.
  if (envelope.type === 'agent-games.proof-gatekeeper.v1' && envelope.mode === 'practice') {
    log('task.mode', { mode: 'practice' });
  }
  const body = await deps.gatekeeper.handle(envelope);
  sendSigned(res, 200, body, key);
}

function sendSigned(
  res: express.Response,
  status: number,
  body: string,
  key: Buffer,
): void {
  res.set(SIGNATURE_HEADER, sign(key, body));
  res.status(status).type('application/json').send(body);
}

function main(): void {
  const { app, config, prover, beginWarmUp } = createApp();
  const server = http.createServer(app);
  server.requestTimeout = 120000;
  server.headersTimeout = 65000;
  // Bind 0.0.0.0 explicitly: Render's router expects the service on all
  // interfaces of the container, on the PORT it provides.
  server.listen(config.port, '0.0.0.0', () => {
    log('server.started', {
      node: process.version,
      redisConfigured: config.upstashRestUrl !== null && config.upstashRestToken !== null,
      hmacSecretPresent: config.hmacSecret !== null,
      kurierConfigured: config.kurierApiKey !== null,
      production: config.isProduction,
      taskIdEncoding: config.taskIdEncoding,
      port: config.port,
    });
    // Warm the prover after listening so /health answers immediately,
    // even while the warm-up proof is still being generated.
    void beginWarmUp();
  });

  // Graceful shutdown for Render restarts/redeploys (SIGTERM) and Ctrl+C.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('server.shutdown_begin', { signal, inflight: inflightCount });
    server.closeIdleConnections?.();
    server.close(() => {
      log('server.shutdown_complete');
    });
    // Exit as soon as in-flight requests have drained, at the latest ~20 s.
    const poll = setInterval(() => {
      if (inflightCount <= 0) {
        clearInterval(poll);
        log('server.exit');
        process.exit(0);
      }
    }, 200);
    poll.unref();
    const force = setTimeout(() => {
      log('server.shutdown_forced', { inflight: inflightCount });
      process.exit(0);
    }, 20000);
    force.unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run only when launched directly (node dist/src/server.js), not when imported.
const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main();
}
