# Proof Gatekeeper agent (zkVerify Agent Games)

A small Node.js/TypeScript HTTPS service that:

1. Receives **signed task envelopes** from the Agent Games platform at `POST /agent`,
   verifying the HMAC signature over the **raw body before parsing anything**.
2. Answers the signed **preflight** handshake with `{ ok: true, protocolVersion: "v1" }`.
3. Decides **APPROVE / REJECT** with plain, deterministic checks (no AI model involved).
4. Proves its decision as a **Groth16 proof** locally with `snarkjs`, using the official
   circuit artifacts in `circuits/`.
5. For APPROVE: submits the proof to **Kurier** and waits for **Finalized** before
   answering. Fail-closed: no finalized verification -> REJECT.
6. Remembers claimed proof references in **Upstash Redis** (atomic `SET NX`, survives
   Render restarts) and caches each answered task for ~24 hours so platform retries
   get the same decision without redoing proofs.
7. Signs every response with `x-agent-games-signature` over the exact raw response body.

Built for **Render free plan**: restarts at any time, no permanent disk, ~512 MB RAM.
`GET /health` is public, instant, and touches nothing (safe to ping every 5 minutes
by uptime monitors).

## Files

```
gatekeeper-agent/
├── package.json               project metadata + commands
├── tsconfig.json              TypeScript settings
├── .gitignore                 keeps secrets and build output out of GitHub
├── .env.example               blank env template (copy to .env locally)
├── .node-version              Node version Render uses (20.19.0)
├── circuits/
│   ├── gatekeeper.wasm        official artifact (/build)
│   ├── gatekeeper_final.zkey  official artifact (/build)
│   └── gatekeeper_vk.json     verification key exported from the zkey
├── src/
│   ├── server.ts              HTTP routes, 0.0.0.0 binding, graceful shutdown
│   ├── config.ts              environment variables
│   ├── hmac.ts                HMAC verify (inbound) + sign (outbound)
│   ├── gatekeeper.ts          task pipeline, timing budgets, fail-closed
│   ├── checks.ts              the APPROVE/REJECT decision rules
│   ├── reasonCodes.ts         the reason_code strings
│   ├── parse.ts               tolerant field/timestamp parsing
│   ├── encoding.ts            task fields -> circuit inputs
│   ├── prover.ts              snarkjs prove + local verification + warm-up
│   ├── kurier.ts              Kurier submit + poll until Finalized
│   ├── storage.ts             Store interface: Upstash Redis + in-memory fallback
│   └── log.ts                 safe structured logging
├── scripts/
│   └── register-vk.ts         one-time testnet VK registration helper
└── test/
    ├── envelopes.ts           sample envelopes + signing helper
    ├── fake-redis.ts          offline fake of the Upstash REST API
    └── local-test.ts          replays 17 cases, prints PASS/FAIL
```

## Commands

```bash
npm install     # one time, downloads packages
npm test        # builds and runs the 17 local tests -> expect 17/17 passed
npm start       # starts the server (reads .env locally; PORT default 3000)
```

Then check `http://localhost:3000/health` in a browser -> should print `ok`.

## GO LIVE checklist (start to finish)

**1. Push to GitHub** (in `F:\Agent\gatekeeper-agent`, PowerShell):

```powershell
git status                  # should be empty/clean
git add .
git commit -m "Proof Gatekeeper agent - live ready"
git remote add origin https://github.com/YOUR-USERNAME/gatekeeper-agent.git
git branch -M main
git push -u origin main
```

Before pushing, confirm: `git ls-files` shows NO `.env`, no `node_modules`, no `dist`;
`.gitignore` covers `.env` and `node_modules`; no secret was ever pasted into a file.

**2. Create the Render service** (dashboard -> New -> Web Service):
- Connect your GitHub repo `gatekeeper-agent`.
- Runtime: **Node**. Build command: `npm install && npm run build`.
  Start command: `npm start`.
- Advanced -> Health Check Path: **`/health`**.
- Environment variable NAMES to add (values come from you, never the repo):
  `AGENT_GAMES_HMAC_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
  `KURIER_API_KEY`, `KURIER_API_URL` (`https://api.kurier.xyz/api/v1`),
  `TASK_ID_ENCODING` (`keccak`), `NODE_ENV` (`production`).
- Create Web Service. First deploy takes a few minutes.

**3. Connect the platform (Rotate Secret):**
1. Copy your service URL, e.g. `https://gatekeeper-agent-xxxx.onrender.com`.
2. On the Agent Games dashboard register the endpoint as the FULL path:
   `https://gatekeeper-agent-xxxx.onrender.com/agent` (not just the root).
3. Dashboard -> **Rotate Secret** -> copy the one-time plaintext -> Render ->
   your service -> Environment -> set `AGENT_GAMES_HMAC_SECRET` -> Save
   (Render restarts the service) -> wait 1-2 minutes.
4. Run **preflight** on the dashboard. Then run **practice mode** tasks before
   any scored round.

**4. Read the Render logs - lines that mean success:**

| Log line | Meaning |
|---|---|
| `CONFIG ERROR: ...` | a required variable is missing/placeholder - fix in Environment, save |
| `{"event":"server.started",...,"redisConfigured":true,...,"configuredOk":true}` | boot OK, Redis + HMAC + Kurier all set |
| `{"event":"prover.warmup_ok","proveMs":...}` | proving engine warmed up (~1.5 s) |
| `{"event":"preflight.received",...}` | the platform preflight arrived and was answered |
| `{"event":"task.answered",...,"decision":"APPROVE"...}` | a task was decided, with `storeMs/checksMs/proveMs/kurierMs/totalMs` |

**5. Keep it awake - two free monitors pinging `/health` every 5 minutes:**
- **UptimeRobot**: Add New Monitor -> HTTP(s) -> URL
  `https://YOUR-SERVICE.onrender.com/health` -> Interval 5 minutes.
- **cron-job.org**: Create cronjob -> same URL -> "Every 5 minutes" -> enabled.

## Environment variables (set on Render, or in .env locally)

| Name | Meaning |
|---|---|
| `AGENT_GAMES_HMAC_SECRET` | the platform secret from "Rotate Secret". Required. |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (free tier). Both UPSTASH vars together. |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token. Never logged. |
| `KURIER_API_KEY` | Kurier API key (mainnet: kurier.xyz, testnet: testnet.kurier.xyz) |
| `KURIER_API_URL` | `https://api.kurier.xyz/api/v1` (mainnet) or `https://api-testnet.kurier.xyz/api/v1` |
| `TASK_ID_ENCODING` | `keccak` (default) / `sha256` / `ascii` / `hex-digits` - see Known unknowns |
| `NODE_ENV` | set to `production` on Render |

Optional tuning (safe defaults built in): `PROOF_BUDGET_MS`, `KURIER_BUDGET_MS`,
`DEADLINE_MARGIN_MS`, `ABSOLUTE_CAP_MS`, `KURIER_POLL_MS`, `MAX_STORE_ENTRIES`.
Dev-only: `SKIP_KURIER=1` skips Kurier in local tests; it is **hard-ignored**
when `NODE_ENV=production`.

## How one task flows (and what the logs show)

```
task.received -> task.checked (storeMs, checksMs) -> task.proven (proveMs)
             -> task.kurier (kurierMs, APPROVE only) -> task.answered (totalMs)
```

Budgets: proofs get at most `PROOF_BUDGET_MS` (20 s) and Kurier at most
`KURIER_BUDGET_MS` (25 s), both capped by the task's own `deadline_at` minus a
6 s margin. Every Redis call has a 3 s timeout and at most one retry. A
watchdog answers `REJECT / TIMEOUT` if anything hangs. Worst case is well
inside the platform's 60 s deadline; if the time runs out the agent **fails
closed** (REJECT), never approves unverified.

Fail-closed reasons you may see: `STORE_UNAVAILABLE` (proof-reference store
down), `WARMING_UP` (task arrived during boot warm-up), `TIMEOUT`,
`PROOF_FAILED`, `STALE_TIMESTAMP`, `MALFORMED_INPUT`, `INTERNAL_ERROR`.
An APPROVE is only ever sent with a locally-verified proof AND a Kurier
`Finalized` result.

## Setting up Upstash Redis (free) - beginner steps

1. Go to **https://upstash.com** and click **Sign Up** (use Google or GitHub).
2. From the console dashboard, click **Create Database**.
3. Name: anything (e.g. `gatekeeper-agent`). Type: **Regional** (free tier).
   Choose a region near your Render service (e.g. `us-east-1` if Render is US).
   Everything else can stay at the defaults. Click **Create**.
4. On the database page, find the **REST API** section (not the regular
   connection details). You will see two strings:
   - **UPSTASH_REDIS_REST_URL** - looks like `https://xxxx.upstash.io`
   - **UPSTASH_REDIS_REST_TOKEN** - a long token
5. Copy each one. **Where to paste them**: Render dashboard -> your service ->
   **Environment** -> Add Environment Variable. Paste the name and its value.
   Never put them in GitHub and never paste them in chats or emails.
6. Save changes - Render will restart the service automatically.
7. Check the Render logs: `server.started` should show `redisConfigured: true`.

Note: the agent uses the REST API only (plain `fetch`, no SDK), with `SET ... NX`
(atomic "set if not exists") for proof references (~30 day expiry) and cached
answers per task_id (~24 hour expiry).

## Render free checklist

| Item | Value |
|---|---|
| Type | Web Service, runtime Node |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |
| Node version | auto from `.node-version` (20.19.0) |
| Health check path | `/health` |
| Env vars (names) | `AGENT_GAMES_HMAC_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `KURIER_API_KEY`, `KURIER_API_URL`, `TASK_ID_ENCODING`, `NODE_ENV` |
| `NODE_ENV` value | `production` |

**Keep-awake monitors (two free ones, both ping `/health` every 5 minutes):**

1. **UptimeRobot** (uptimerobot.com): create a free account -> Add New Monitor
   -> Monitor Type: **HTTP(s)** -> Friendly name: `gatekeeper-health` ->
   URL: `https://YOUR-SERVICE.onrender.com/health` -> Interval: **5 minutes** ->
   Create Monitor.
2. **cron-job.org** (cron-job.org): create a free account -> Cronjobs ->
   **Create cronjob** -> Title: `gatekeeper-health` -> URL:
   `https://YOUR-SERVICE.onrender.com/health` -> Schedule: "Every 5 minutes"
   -> Save, and make sure the job is enabled.

Two monitors pinging 5 minutes apart keep the service warm almost continuously
(each ping resets Render's 15-minute idle timer). The `/health` endpoint is
deliberately trivial so these pings never touch Redis, the prover, or Kurier.

**Restart behavior:** on Render restarts the process stops cleanly (SIGTERM:
in-flight tasks get up to ~20 s to finish) and starts again; Redis keeps the
seen-proof references and cached answers, so restarts are safe.

## Registering and testing on the platform

1. GitHub: push the repo (public), connect it on Render, deploy with the
   settings above.
2. Register your agent endpoint as the **full path**:
   `https://YOUR-SERVICE.onrender.com/agent`
3. Dashboard -> **Rotate Secret** -> copy the one-time plaintext -> paste it as
   the value of `AGENT_GAMES_HMAC_SECRET` in Render -> save (this restarts the
   service) -> wait ~1-2 minutes -> run **preflight**.
4. Run **practice mode** tasks before scored rounds.

## Known unknowns (verify with practice mode)

1. **task_id -> circuit `taskId` mapping.** The platform does not document how the
   text `task_id` ("gk_...") becomes the circuit's numeric input. Default is
   `keccak256(task_id) mod p`. If a *valid* practice task comes back with
   "proof invalid", try another `TASK_ID_ENCODING` value and re-run practice.
2. **HMAC key bytes** (UTF-8 of the plaintext vs hex-decoded). Both are tried;
   responses are signed with whichever key verified the request.
3. **Internal reason codes** (`TIMEOUT`, `PROOF_FAILED`, `STALE_TIMESTAMP`,
   `MALFORMED_INPUT`, `INTERNAL_ERROR`, `STORE_UNAVAILABLE`, `WARMING_UP`) are
   not from the official docs - they exist so the agent can fail closed. The
   six trap codes are official.
4. **The third-party proof is not verified on-chain.** The envelope already
   carries every value the event's trap checks compare (VK, threshold,
   recipient, expiry, amount, reuse). An on-chain lookup via zkVerifyJS would
   add latency and needs more infrastructure; skipping it is a deliberate
   simplification.
5. **Kurier mainnet latency under load** is unmeasured. Local proof generation
   is 0.4-1.5 s. The logs show real `kurierMs`; if Finalized regularly
   overruns the budget the agent rejects (score -2/-3 instead of -6), which is
   the safe outcome.

## Testnet rehearsal (optional)

1. Get a **testnet** key at https://testnet.kurier.xyz and set
   `KURIER_API_KEY` + `KURIER_API_URL=https://api-testnet.kurier.xyz/api/v1`.
2. Run `npm run register-vk` once (registers the official VK; the hash is
   deterministic and matches the official mainnet hash).
3. Submit any practice-task proof through the agent as usual.
