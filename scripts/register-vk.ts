import 'dotenv/config';
import fs from 'node:fs';

/**
 * One-time helper: registers the official gatekeeper verification key with
 * Kurier. Only needed for TESTNET rehearsals (the key is already registered
 * on zkVerify mainnet under the hash shown on the /build page).
 * Requires KURIER_API_KEY and KURIER_API_URL (testnet URL) in the env.
 *
 * Run:  npm run register-vk
 * The vk hash is deterministic, so the result matches the official
 * 0x6b79c601... hash. The API key is never printed.
 */
async function main(): Promise<void> {
  // Production guard: this helper is ONLY for optional testnet rehearsals.
  // For the competition you do NOT need it - the platform has already
  // registered the gatekeeper verification key on zkVerify mainnet, and the
  // agent submits proofs with that official vk hash (vkRegistered: true).
  if (process.env.NODE_ENV === 'production') {
    console.log('REFUSING to run: register-vk is a testnet-only helper and NODE_ENV is production. Nothing was changed.');
    process.exit(1);
  }
  const apiKey = process.env.KURIER_API_KEY;
  const apiUrl = process.env.KURIER_API_URL || 'https://api-testnet.kurier.xyz/api/v1';
  if (!apiKey) {
    console.log('KURIER_API_KEY is not set. Nothing to do.');
    process.exit(1);
  }
  const vk = JSON.parse(fs.readFileSync('circuits/gatekeeper_vk.json', 'utf8'));
  try {
    const res = await fetch(`${apiUrl}/register-vk/${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proofType: 'groth16',
        proofOptions: { library: 'snarkjs', curve: 'bn128' },
        vk,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = (await res.json()) as { vkHash?: string; meta?: { vkHash?: string } };
    console.log('http status:', res.status);
    console.log('vkHash:', JSON.stringify(body.vkHash ?? body.meta?.vkHash ?? body));
  } catch (e) {
    // The API key travels in the URL path - scrub it (and the URL) out of any
    // fetch error text before it reaches the console.
    const { scrubKurierError } = await import('../src/kurier.js');
    console.log('register-vk failed:', scrubKurierError(e, apiKey, apiUrl));
    process.exit(1);
  }
}

void main();
