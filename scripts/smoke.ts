import { spawn } from 'node:child_process';
import path from 'node:path';
import { sign } from '../src/hmac.js';

/**
 * Local smoke test (never uses real secrets):
 *   1. starts the BUILT server (dist/src/server.js) on a free port with a
 *      DUMMY secret and no Kurier/Redis configuration,
 *   2. checks GET /health returns "ok",
 *   3. checks a correctly signed preflight returns { ok: true,
 *      protocolVersion: "v1" } with a valid x-agent-games-signature header,
 *   4. checks a badly signed request is rejected (401),
 *   5. stops the server and prints PASS/FAIL per check.
 *
 * Run:  npm run smoke
 */
const DUMMY_SECRET = 'smoke-dummy-secret-not-real-never-use-for-the-platform';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function record(check: Check): void {
  console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}${check.pass ? '' : `  -> ${check.detail}`}`);
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200 && (await res.text()) === 'ok') return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main(): Promise<void> {
  const port = 39000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join('dist', 'src', 'server.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'test', // dev mode on purpose: no Kurier/Redis needed here
      AGENT_GAMES_HMAC_SECRET: DUMMY_SECRET,
      KURIER_API_KEY: '',
      KURIER_API_URL: 'https://api.kurier.xyz/api/v1',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      PORT: String(port),
    },
    stdio: 'ignore',
  });

  const checks: Check[] = [];
  try {
    const healthOk = await waitForHealth(port, 20000);
    checks.push({ name: 'server boots and /health returns "ok"', pass: healthOk, detail: 'health did not come up in 20 s' });
    record(checks[0]);

    if (healthOk) {
      // Preflight, signed the way the platform signs.
      const preflightBody = JSON.stringify({
        type: 'agent-games.preflight.v1',
        agent_id: 'agt_smoke',
        issued_at: new Date().toISOString(),
        nonce: 'smoke',
      });
      const goodSignature = sign(Buffer.from(DUMMY_SECRET, 'utf8'), preflightBody);
      const goodRes = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-games-signature': goodSignature },
        body: preflightBody,
      });
      const goodText = await goodRes.text();
      const goodHeader = goodRes.headers.get('x-agent-games-signature');
      let goodObj: Record<string, unknown> = {};
      try {
        goodObj = JSON.parse(goodText) as Record<string, unknown>;
      } catch {
        // reported below
      }
      const expectedSig = sign(Buffer.from(DUMMY_SECRET, 'utf8'), goodText);
      const preflightOk =
        goodRes.status === 200 &&
        goodObj.ok === true &&
        goodObj.protocolVersion === 'v1' &&
        goodHeader !== null &&
        goodHeader.toLowerCase() === expectedSig;
      const preflightCheck: Check = {
        name: 'signed preflight -> { ok: true, protocolVersion: "v1" } with valid signature header',
        pass: preflightOk,
        detail: `status=${goodRes.status} body=${goodText}`,
      };
      checks.push(preflightCheck);
      record(preflightCheck);

      // The same request with a BROKEN signature must be rejected.
      const badRes = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-games-signature': 'bad'.repeat(22) },
        body: preflightBody,
      });
      const badOk = badRes.status === 401;
      const badCheck: Check = {
        name: 'badly signed request -> rejected (401), nothing processed',
        pass: badOk,
        detail: `status=${badRes.status}`,
      };
      checks.push(badCheck);
      record(badCheck);
    }
  } finally {
    child.kill();
  }

  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} smoke checks passed${failed === 0 ? '' : `, ${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
