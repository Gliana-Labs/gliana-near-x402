/**
 * Deploy the Saku factory (contract/factory) to an account you hold the key for, and initialise it.
 *
 *   FACTORY_KEY_FILE=~/.near-gliana/saku-factory.testnet.json NEAR_NETWORK=testnet npm run factory:deploy
 *
 * Build first, in this order (the factory embeds the allowance's wasm): npm run contract:build && npm run factory:build
 * The account needs ~4 NEAR for the factory's own storage (391 KB). Re-running redeploys the code and keeps the state.
 */
import { readFileSync } from 'node:fs';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { rpcUrl, type NearNetwork } from './x402-payer.js';

const NETWORK = (process.env.NEAR_NETWORK ?? 'testnet') as NearNetwork;
const SIGNER = NETWORK === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet';
const keyFile = process.env.FACTORY_KEY_FILE;
if (!keyFile) throw new Error('Set FACTORY_KEY_FILE to the factory account key file.');
const k = JSON.parse(readFileSync(keyFile, 'utf8')) as { account_id: string; private_key: string };
const provider = new JsonRpcProvider({ url: rpcUrl(NETWORK) });
const factory = new Account(k.account_id, provider, new KeyPairSigner(KeyPair.fromString(k.private_key as `ed25519:${string}`)));

await factory.deployContract(readFileSync('contract/factory/target/near/saku_factory.wasm'));
let ready = false;
try {
  await provider.callFunction(k.account_id, 'get_config', {});
  ready = true;
} catch {
  /* not initialised yet */
}
if (!ready) await factory.callFunction({ contractId: k.account_id, methodName: 'new', args: { signer: SIGNER, path: 'saku' }, gas: 30_000_000_000_000n });
console.log(k.account_id, JSON.stringify(await provider.callFunction(k.account_id, 'get_config', {})));
