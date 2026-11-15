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
  const apiKey = process.env.KURIER_API_KEY;
  const apiUrl = process.env.KURIER_API_URL || 'https://api-testnet.kurier.xyz/api/v1';
  if (!apiKey) {
    console.log('KURIER_API_KEY is not set. Nothing to do.');
    process.exit(1);
  }
  const vk = JSON.parse(fs.readFileSync('circuits/gatekeeper_vk.json', 'utf8'));
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
}

void main();
