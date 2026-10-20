/**
 * The whole thing, end to end: a NEAR account buys an AI inference call.
 *
 *   1. derive the Base address this NEAR account controls   (offline, free)
 *   2. ask GlianaAI for something, get a 402 with a price
 *   3. build the EIP-3009 authorization and hash it         (offline)
 *   4. NEAR's MPC signs that hash                           (~15s, costs gas)
 *   5. retry with X-PAYMENT; USDC moves; the answer arrives
 *
 * No EVM private key exists at any point.
 */
import { readFileSync } from 'node:fs';
import { payWithNear, deriveEvmAddress, type NearNetwork } from './x402-payer.js';
import { nearSigner } from './signer.js';

const KEY_FILE = process.env.NEAR_KEY_FILE;
const ACCOUNT = process.env.NEAR_ACCOUNT_ID;
const PRIVATE = process.env.NEAR_PRIVATE_KEY;
const NETWORK = (process.env.NEAR_NETWORK ?? 'mainnet') as NearNetwork;
const PATH = process.env.NEAR_PATH ?? 'gliana-x402';
const URL = process.env.GLIANA_URL ?? 'https://api.glianalabs.com/x402/tools/token-price';
const BODY = JSON.parse(process.env.GLIANA_BODY ?? '{"symbols":"NEAR,SOL","vs":"usd"}');

function credentials(): { accountId: string; privateKey: string } {
  if (ACCOUNT && PRIVATE) return { accountId: ACCOUNT, privateKey: PRIVATE };
  if (KEY_FILE) {
    const k = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
    return { accountId: k.account_id, privateKey: k.private_key };
  }
  console.error('Set NEAR_KEY_FILE=/path/to/key.json, or NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY.');
  console.error('A key file is {"account_id":"...","private_key":"ed25519:..."}.');
  process.exit(1);
}

const { accountId, privateKey } = credentials();
const from = await deriveEvmAddress(accountId, PATH, NETWORK);

console.log(`NEAR account : ${accountId}  (${NETWORK})`);
console.log(`Base address : ${from}   <- derived offline, no key exists for it`);
console.log(`Buying       : ${URL}`);
console.log('');

const result = await payWithNear({
  url: URL,
  body: BODY,
  from,
  sign: nearSigner({ accountId, privateKey, path: PATH, network: NETWORK, onWait: (m) => console.log(`  ${m}`) }),
});

console.log('');
if (result.status === 200) {
  console.log(`PAID ${result.chargedMicroUsd} microUSD on ${result.network}`);
  console.log(`digest ${result.digest}`);
  console.log('');
  console.log(JSON.stringify(result.body, null, 2).slice(0, 1200));
} else {
  // Never retried automatically: the nonce is single-use, and if the first
  // authorization DID settle, a retry pays twice for one answer.
  console.error(`NOT PAID — HTTP ${result.status}`);
  console.error(JSON.stringify(result.body, null, 2).slice(0, 800));
  console.error(`\nThe digest was ${result.digest}; use it to reconcile before retrying.`);
  process.exit(1);
}
