/**
 * Deploy a new build of contract/ over an existing allowance, keeping its state
 * (owner, agent, policy, today's spend). Uses the contract account's own key from
 * ~/.near-gliana/ — the one deploy-allowance.ts saved.
 *
 *   ALLOWANCE=allowance.you.near NEAR_NETWORK=mainnet npm run allowance:upgrade
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
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
await account.deployContract(readFileSync('contract/target/near/agent_allowance.wasm'));
const after = JSON.stringify(await provider.callFunction(ALLOWANCE, 'get_policy', {}));
console.log(`upgraded ${ALLOWANCE} (${NETWORK}); policy ${before === after ? 'unchanged' : 'CHANGED'}`);
