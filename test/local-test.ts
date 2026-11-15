/**
 * Local test harness: replays signed task envelopes against running app
 * instances (no internet needed; Kurier is skipped in tests via SKIP_KURIER).
 * Prints PASS/FAIL per case and exits non-zero if anything failed.
 *
 * Coverage:
 *   Part A - in-memory store:  health, preflight, valid approve, bad
 *            signature, the 5 field traps, reuse, stale, malformed (12)
 *   Part B - Redis store (fake Upstash REST, offline): same-task retry is
 *            NOT reuse, different-task reuse, concurrent claim (3)
 *   Part C - Redis down/slow: fail closed with STORE_UNAVAILABLE (1)
 *   Part D - task during boot warm-up: signed REJECT, /health instant (1)
 *   Part E - Kurier API key (URL path) never appears in any log or error (3)
 *
 * Run:  npm test
 */
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { sign } from '../src/hmac.js';
import { Kurier, KurierResult, scrubKurierSecrets } from '../src/kurier.js';
import { loadConfig } from '../src/config.js';
import {
  TEST_SECRET,
  validEnvelope,
  preflightEnvelope,
  signedRequest,
} from './envelopes.js';
import { startFakeRedis, FakeRedis } from './fake-redis.js';

// ---- Test environment BEFORE anything loads config -------------------------
process.env.AGENT_GAMES_HMAC_SECRET = TEST_SECRET;
process.env.SKIP_KURIER = '1';
process.env.NODE_ENV = 'test';
process.env.TASK_ID_ENCODING = 'keccak';
process.env.KURIER_API_KEY = '';
// Part A baseline: no Redis configured (empty string -> config reads null).
process.env.UPSTASH_REDIS_REST_URL = '';
process.env.UPSTASH_REDIS_REST_TOKEN = '';

const results: { name: string; pass: boolean; detail: string }[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  -> ${detail}`}`);
}

interface Reply {
  status: number;
  text: string;
  signature: string | null;
}

async function post(
  port: number,
  body: string,
  signature: string,
): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${port}/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-games-signature': signature },
    body,
  });
  return {
    status: res.status,
    text: await res.text(),
    signature: res.headers.get('x-agent-games-signature'),
  };
}

function expectSignatureValid(name: string, reply: Reply): boolean {
  if (reply.signature === null) {
    record(name, false, 'missing x-agent-games-signature header');
    return false;
  }
  const expected = sign(Buffer.from(TEST_SECRET, 'utf8'), reply.text);
  if (expected !== reply.signature.toLowerCase()) {
    record(name, false, 'response signature mismatch');
    return false;
  }
  return true;
}

interface Instance {
  port: number;
  close: () => Promise<void>;
}

interface AppHandle {
  app: import('express').Express;
  beginWarmUp?: () => Promise<void>;
}

async function startInstance(handle: AppHandle): Promise<Instance> {
  const server = http.createServer(handle.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function parseReply(reply: Reply): Record<string, unknown> {
  try {
    return JSON.parse(reply.text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const { createApp } = await import('../src/server.js');

  // =========================================================================
  // PART A - in-memory store: the original 12 cases.
  // =========================================================================
  const aHandle = createApp();
  const a = await startInstance(aHandle);
  await aHandle.beginWarmUp();

  // A1. health
  {
    const res = await fetch(`http://127.0.0.1:${a.port}/health`);
    const text = await res.text();
    record('health returns "ok", no auth needed', res.status === 200 && text === 'ok', `status=${res.status} body=${text}`);
  }

  // A2. preflight
  {
    const { body, signature } = signedRequest(TEST_SECRET, preflightEnvelope());
    const reply = await post(a.port, body, signature);
    const obj = parseReply(reply);
    const okShape = reply.status === 200 && obj.ok === true && obj.protocolVersion === 'v1';
    const sigOk = expectSignatureValid('preflight', reply);
    record('preflight answers { ok: true, protocolVersion: "v1" }, signed', okShape && sigOk, reply.text);
  }

  // A3. valid condition -> APPROVE with proof
  {
    const env = validEnvelope({ task_id: 'gk_test_valid' });
    const proofTx = (env.input as { proof_tx: string }).proof_tx;
    const { body, signature } = signedRequest(TEST_SECRET, env);
    const reply = await post(a.port, body, signature);
    const obj = parseReply(reply);
    const okShape =
      reply.status === 200 &&
      obj.decision === 'APPROVE' &&
      obj.reason_code === 'VALID_CONDITION' &&
      obj.proof !== undefined &&
      Array.isArray(obj.public_signals) &&
      (obj.public_signals as unknown[]).length === 13 &&
      obj.proof_tx === proofTx;
    const sigOk = expectSignatureValid('valid-approve', reply);
    record('valid condition -> APPROVE + 13 public_signals + signature', okShape && sigOk, reply.text);
  }

  // A4. bad signature -> 401
  {
    const { body } = signedRequest(TEST_SECRET, validEnvelope({ task_id: 'gk_test_badsig' }));
    const reply = await post(a.port, body, 'deadbeef'.repeat(8));
    record('bad signature -> 401 before parsing', reply.status === 401, `status=${reply.status}`);
  }

  // A5-A9. the five field traps
  const traps: { name: string; task_id: string; over: Record<string, unknown>; expect: string }[] = [
    {
      name: 'key substitution -> REJECT VK_SUBSTITUTION',
      task_id: 'gk_test_vk',
      over: { proof_vk: '0x13000000000000000000000000000000000000000000000000000000000aa' },
      expect: 'VK_SUBSTITUTION',
    },
    {
      name: 'threshold mismatch -> REJECT THRESHOLD_MISMATCH',
      task_id: 'gk_test_threshold',
      over: { public_balance: '900' },
      expect: 'THRESHOLD_MISMATCH',
    },
    {
      name: 'recipient mismatch -> REJECT RECIPIENT_MISMATCH',
      task_id: 'gk_test_recipient',
      over: { recipient: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9f01' },
      expect: 'RECIPIENT_MISMATCH',
    },
    {
      name: 'amount overflow -> REJECT AMOUNT_OVERFLOW',
      task_id: 'gk_test_amount',
      over: { amount: '1001' },
      expect: 'AMOUNT_OVERFLOW',
    },
    {
      name: 'expired block -> REJECT EXPIRED_CONDITION',
      task_id: 'gk_test_expired',
      over: { current_block: 99999999 },
      expect: 'EXPIRED_CONDITION',
    },
  ];
  for (const trap of traps) {
    const env = validEnvelope({ task_id: trap.task_id, input: trap.over as never });
    const { body, signature } = signedRequest(TEST_SECRET, env);
    const reply = await post(a.port, body, signature);
    const obj = parseReply(reply);
    const okShape = reply.status === 200 && obj.decision === 'REJECT' && obj.reason_code === trap.expect;
    const sigOk = expectSignatureValid(trap.name, reply);
    record(trap.name, okShape && sigOk, reply.text);
  }

  // A10. reused proof reference (in-memory)
  {
    const sharedRef = `0xreuse${Math.random().toString(16).slice(2).padEnd(12, '0')}`;
    const first = validEnvelope({ task_id: 'gk_test_reuse_a', input: { proof_tx: sharedRef } });
    const r1 = signedRequest(TEST_SECRET, first);
    const reply1 = await post(a.port, r1.body, r1.signature);
    const firstOk = reply1.status === 200 && parseReply(reply1).decision === 'APPROVE';

    const second = validEnvelope({ task_id: 'gk_test_reuse_b', input: { proof_tx: sharedRef } });
    const r2 = signedRequest(TEST_SECRET, second);
    const reply = await post(a.port, r2.body, r2.signature);
    const obj = parseReply(reply);
    const reusedOk =
      reply.status === 200 && obj.decision === 'REJECT' && obj.reason_code === 'PROOF_REUSED' && obj.proof === undefined;
    const sigOk = expectSignatureValid('proof-reused', reply);
    record(`reused proof reference -> REJECT PROOF_REUSED (first send approved: ${firstOk})`, firstOk && reusedOk && sigOk, reply.text);
  }

  // A11. stale timestamp (deadline already passed)
  {
    const env = validEnvelope({
      task_id: 'gk_test_stale',
      deadline_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const { body, signature } = signedRequest(TEST_SECRET, env);
    const reply = await post(a.port, body, signature);
    const obj = parseReply(reply);
    const okShape = reply.status === 200 && obj.decision === 'REJECT' && obj.reason_code === 'STALE_TIMESTAMP';
    record('stale timestamp (past deadline) -> REJECT STALE_TIMESTAMP', okShape, reply.text);
  }

  // A12. signed garbage -> REJECT MALFORMED_INPUT
  {
    const env = {
      type: 'agent-games.proof-gatekeeper.v1',
      task_id: 'gk_test_garbage',
      deadline_at: new Date(Date.now() + 45_000).toISOString(),
      input: { nonsense: true },
    };
    const { body, signature } = signedRequest(TEST_SECRET, env);
    const reply = await post(a.port, body, signature);
    const obj = parseReply(reply);
    const okShape = reply.status === 200 && obj.decision === 'REJECT' && obj.reason_code === 'MALFORMED_INPUT';
    record('unparsable fields -> REJECT MALFORMED_INPUT', okShape, reply.text);
  }

  await a.close();

  // =========================================================================
  // PART B - Redis store (offline fake of Upstash REST).
  // =========================================================================
  const fake: FakeRedis = await startFakeRedis({ token: 'test-token' });
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${fake.port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const bHandle = createApp();
  const b = await startInstance(bHandle);
  await bHandle.beginWarmUp(); // real warm-up, then ready

  // B13. SAME task_id retried with the same proof reference -> NOT reused
  {
    const env = validEnvelope({ task_id: 'gk_test_redis_retry' });
    const first = signedRequest(TEST_SECRET, env);
    const reply1 = await post(b.port, first.body, first.signature);
    const obj1 = parseReply(reply1);
    const second = signedRequest(TEST_SECRET, env); // identical task_id + ref
    const reply2 = await post(b.port, second.body, second.signature);
    const obj2 = parseReply(reply2);
    const sameDecision =
      reply1.status === 200 &&
      reply2.status === 200 &&
      obj1.decision === 'APPROVE' &&
      obj2.decision === obj1.decision &&
      obj2.reason_code !== 'PROOF_REUSED' &&
      reply2.text === reply1.text; // identical stored answer, re-signed
    const sigOk = expectSignatureValid('redis-same-task-retry', reply2);
    record('same task_id retried -> same decision, NOT PROOF_REUSED', sameDecision && sigOk, `first=${reply1.text} second=${reply2.text}`);
  }

  // B14. DIFFERENT task_id with the same proof reference -> PROOF_REUSED
  {
    const sharedRef = `0xredis${Math.random().toString(16).slice(2).padEnd(12, '0')}`;
    const firstEnv = validEnvelope({ task_id: 'gk_test_redis_ref_a', input: { proof_tx: sharedRef } });
    const r1 = signedRequest(TEST_SECRET, firstEnv);
    await post(b.port, r1.body, r1.signature);

    const secondEnv = validEnvelope({ task_id: 'gk_test_redis_ref_b', input: { proof_tx: sharedRef } });
    const r2 = signedRequest(TEST_SECRET, secondEnv);
    const reply = await post(b.port, r2.body, r2.signature);
    const obj = parseReply(reply);
    const okShape = reply.status === 200 && obj.decision === 'REJECT' && obj.reason_code === 'PROOF_REUSED';
    const sigOk = expectSignatureValid('redis-different-task-reuse', reply);
    record('different task_id, same proof reference -> REJECT PROOF_REUSED (Redis)', okShape && sigOk, reply.text);
  }

  // B15. two concurrent requests, same NEW reference, different task_ids
  {
    const sharedRef = `0xconc${Math.random().toString(16).slice(2).padEnd(12, '0')}`;
    const envA = validEnvelope({ task_id: 'gk_test_conc_a', input: { proof_tx: sharedRef } });
    const envB = validEnvelope({ task_id: 'gk_test_conc_b', input: { proof_tx: sharedRef } });
    const reqA = signedRequest(TEST_SECRET, envA);
    const reqB = signedRequest(TEST_SECRET, envB);
    const [replyA, replyB] = await Promise.all([
      post(b.port, reqA.body, reqA.signature),
      post(b.port, reqB.body, reqB.signature),
    ]);
    const decisions = [parseReply(replyA).decision, parseReply(replyB).decision];
    const reasons = [parseReply(replyA).reason_code, parseReply(replyB).reason_code];
    const exactlyOneApproved =
      decisions.filter((d) => d === 'APPROVE').length === 1 &&
      reasons.filter((r) => r === 'PROOF_REUSED').length === 1;
    record('two concurrent same-reference claims -> exactly one APPROVE, one PROOF_REUSED', exactlyOneApproved, `decisions=${decisions.join('/')} reasons=${reasons.join('/')}`);
  }

  // Small settle time so the best-effort cache write-backs complete before
  // the fake Redis goes away (keeps the output clean).
  await new Promise((resolve) => setTimeout(resolve, 150));
  await b.close();
  await fake.close();

  // =========================================================================
  // PART C - Redis down / too slow -> fail closed with STORE_UNAVAILABLE.
  // =========================================================================
  const slowFake: FakeRedis = await startFakeRedis({ token: 'test-token', delayMs: 5000 });
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${slowFake.port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const cHandle = createApp();
  const c = await startInstance(cHandle);
  await cHandle.beginWarmUp();
  {
    const env = validEnvelope({ task_id: 'gk_test_redis_down' });
    const req = signedRequest(TEST_SECRET, env);
    const reply = await post(c.port, req.body, req.signature);
    const obj = parseReply(reply);
    const okShape = reply.status === 200 && obj.decision === 'REJECT' && obj.reason_code === 'STORE_UNAVAILABLE';
    const sigOk = expectSignatureValid('redis-down', reply);
    record('Redis slow/timing out -> REJECT STORE_UNAVAILABLE (fail closed)', okShape && sigOk, reply.text);
  }
  await c.close();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await slowFake.close();

  // =========================================================================
  // PART D - task arriving before warm-up finishes -> signed REJECT, no crash.
  // =========================================================================
  process.env.UPSTASH_REDIS_REST_URL = '';
  process.env.UPSTASH_REDIS_REST_TOKEN = '';
  const neverWarm = (): Promise<void> => new Promise<void>(() => {}); // never resolves
  const dHandle = createApp({ warmUp: neverWarm });
  const d = await startInstance(dHandle);
  // Intentionally NOT calling beginWarmUp: ready stays false for this test.
  {
    // /health must still answer instantly.
    const health = await fetch(`http://127.0.0.1:${d.port}/health`);
    const healthOk = health.status === 200 && (await health.text()) === 'ok';

    const env = validEnvelope({ task_id: 'gk_test_warmup' });
    const req = signedRequest(TEST_SECRET, env);
    const reply = await post(d.port, req.body, req.signature);
    const obj = parseReply(reply);
    const okShape = reply.status === 200 && obj.decision === 'REJECT' && obj.reason_code === 'WARMING_UP';
    const sigOk = expectSignatureValid('warmup-gate', reply);
    record('task before warm-up finishes -> signed REJECT WARMING_UP, /health still "ok"', okShape && sigOk && healthOk, reply.text);
  }
  await d.close();

  // =========================================================================
  // PART E - the Kurier API key travels in the URL path. NO log line, error
  // message, or exception text may ever contain it (or the full URL).
  // =========================================================================
  {
    const LEAK_KEY = 'TEST_KURIER_KEY_DO_NOT_LEAK_9f2a';
    const LEAK_URL = 'not-a-valid-url'; // makes fetch throw with the URL in its message

    // E16. The scrub helper itself (unit).
    const dirty = `Failed to parse URL from ${LEAK_URL}/submit-proof/${LEAK_KEY}`;
    const clean = scrubKurierSecrets(dirty, LEAK_KEY, LEAK_URL);
    record(
      'scrub helper removes the Kurier key and URL from error text',
      clean === 'Failed to parse URL from <kurier-url>/submit-proof/<kurier-key>' && !clean.includes(LEAK_KEY),
      clean,
    );

    // Capture every console.log line the Kurier client emits.
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]): void => {
      lines.push(args.map((a) => String(a)).join(' '));
    };

    const kurierConfig = loadConfig();
    kurierConfig.kurierApiKey = LEAK_KEY;

    // E17. Malformed URL: Node's fetch error embeds the FULL URL (key included)
    // in its message ("Failed to parse URL from ...") - the log must be scrubbed.
    kurierConfig.kurierApiUrl = LEAK_URL;
    let r17: KurierResult | null = null;
    try {
      r17 = await new Kurier(kurierConfig).submitAndWait({}, [], 30000);
    } finally {
      console.log = originalLog;
    }
    const e17ok =
      r17 !== null &&
      r17.ok === false &&
      r17.status === 'ERROR' &&
      !lines.some((l) => l.includes(LEAK_KEY) || l.includes(LEAK_URL));
    record(
      'Kurier fetch error (message embeds URL+key) -> logged text scrubbed, no key/URL anywhere',
      e17ok,
      lines.filter((l) => l.includes(LEAK_KEY) || l.includes(LEAK_URL)).join(' | ') || `result=${JSON.stringify(r17)}`,
    );

    // E18. Real HTTP failure: 500 with a hostile non-JSON body. res.json()
    // throws with the response BODY in its message; the result must fail
    // closed and no log line may carry the key or the URL.
    lines.length = 0;
    const badServer = http.createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<html>boom</html>');
    });
    await new Promise<void>((resolve) => badServer.listen(0, '127.0.0.1', resolve));
    const badAddress = badServer.address();
    if (badAddress === null || typeof badAddress === 'string') throw new Error('no port');
    kurierConfig.kurierApiUrl = `http://127.0.0.1:${badAddress.port}`;
    let r18: KurierResult | null = null;
    try {
      r18 = await new Kurier(kurierConfig).submitAndWait({}, [], 30000);
    } finally {
      console.log = originalLog;
    }
    const e18ok =
      r18 !== null &&
      r18.ok === false &&
      !lines.some((l) => l.includes(LEAK_KEY) || l.includes(kurierConfig.kurierApiUrl));
    record(
      'Kurier HTTP 500 / hostile body -> fails closed, logs scrubbed, no key/URL anywhere',
      e18ok,
      lines.filter((l) => l.includes(LEAK_KEY) || l.includes(kurierConfig.kurierApiUrl)).join(' | ') || `result=${JSON.stringify(r18)}`,
    );
    badServer.close();
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed${failed === 0 ? '' : `, ${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
