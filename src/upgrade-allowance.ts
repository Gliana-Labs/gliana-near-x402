/**
 * Deploy a new build of contract/ over an existing allowance, keeping its state
 * (owner, agent, policy, today's spend). Uses the contract account's own key from
 * ~/.near-gliana/ — the one deploy-allowance.ts saved.
 *
 *   ALLOWANCE=allowance.you.near NEAR_NETWORK=mainnet npm run allowance:upgrade
 *
 * MIGRATE=1 also moves the state onto a new layout, in the same transaction as the new code, so there's
 * no moment when the new code runs against the old state. The account, and so the Base address, stay the same.
 * APPROVAL_MAX (micro-USD, default 1000000) and PAYEE_DELAY_S (default 86400) are set then, and only then.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators } from '@near-js/transactions';
import { rpcUrl, type NearNetwork } from './x402-payer.js';

const ALLOWANCE = process.env.ALLOWANCE;
const NETWORK = process.env.NEAR_NETWORK ?? 'mainnet';
if (!ALLOWANCE) {
  console.error('Set ALLOWANCE=allowance.<you>.');
  process.exit(1);
}
const key = JSON.parse(readFileSync(join(homedir(), '.near-gliana', `${ALLOWANCE}.json`), 'utf8')) as { private_key: string };
const provider = new JsonRpcProvider({ url: rpcUrl(NETWORK as NearNetwork) });
const account = new Account(ALLOWANCE, provider, new KeyPairSigner(KeyPair.fromString(key.private_key as `ed25519:${string}`)));
const before = JSON.stringify(await provider.callFunction(ALLOWANCE, 'get_policy', {}));
const wasm = readFileSync('contract/target/near/agent_allowance.wasm');
if (process.env.MIGRATE === '1') {
  const args = { approval_max: process.env.APPROVAL_MAX ?? '1000000', payee_delay_s: process.env.PAYEE_DELAY_S ?? '86400' };
  await account.signAndSendTransaction({
    receiverId: ALLOWANCE,
    actions: [actionCreators.deployContract(wasm), actionCreators.functionCall('migrate', args, 100_000_000_000_000n, 0n)],
  });
} else {
  await account.deployContract(wasm);
}
const after = JSON.stringify(await provider.callFunction(ALLOWANCE, 'get_policy', {}));
// New code may add fields to get_policy (2026-11-09: the hourly and 30-day rules); only the fields that were there
// before have to read the same.
const [b, a] = [JSON.parse(before) as Record<string, unknown>, JSON.parse(after) as Record<string, unknown>];
const changed = Object.keys(b).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
const added = Object.keys(a).filter((k) => !(k in b));
console.log(`upgraded ${ALLOWANCE} (${NETWORK}); policy ${changed.length ? `CHANGED: ${changed.join(', ')}` : 'unchanged'}${added.length ? `; new fields: ${added.join(', ')}` : ''}`);
