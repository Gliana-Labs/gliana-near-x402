/**
 * Deploy the Saku factory (contract/factory) to an account you hold the key for, and initialise it.
 *
 *   FACTORY_KEY_FILE=~/.near-gliana/saku-factory.testnet.json NEAR_NETWORK=testnet npm run factory:deploy
 *
 * Or let it make the account first, as `saku.<parent>`, from the parent's key file (the new key is saved owner-only
 * to ~/.near-gliana/saku.<parent>.json, never printed). FACTORY_NEAR (default 4.5) goes from the parent to it:
 *
 *   PARENT_KEY_FILE=~/.near-gliana/cocoanutx.json NEAR_NETWORK=mainnet npm run factory:deploy
 *
 * Build first, in this order (the factory embeds the allowance's wasm): npm run contract:build && npm run factory:build
 * The account needs ~4 NEAR for the factory's own storage (391 KB). Re-running redeploys the code and keeps the state.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { rpcUrl, type NearNetwork } from './x402-payer.js';

const NETWORK = (process.env.NEAR_NETWORK ?? 'testnet') as NearNetwork;
const SIGNER = NETWORK === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet';
const provider = new JsonRpcProvider({ url: rpcUrl(NETWORK) });
const as = (id: string, key: string) => new Account(id, provider, new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)));
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as { account_id: string; private_key: string };

let keyFile = process.env.FACTORY_KEY_FILE;
if (!keyFile && process.env.PARENT_KEY_FILE) {
  const parent = read(process.env.PARENT_KEY_FILE);
  const id = `saku.${parent.account_id}`;
  keyFile = join(homedir(), '.near-gliana', `${id}.json`);
  if (!existsSync(keyFile)) {
    const exists = await provider.viewAccount(id).then(() => true, () => false);
    if (exists) throw new Error(`${id} exists but its key isn't in ${keyFile}. Pass FACTORY_KEY_FILE instead.`);
    const kp = KeyPair.fromRandom('ed25519');
    mkdirSync(join(homedir(), '.near-gliana'), { recursive: true, mode: 0o700 });
    // Written before the account exists, so a crash never leaves an account whose key is lost.
    writeFileSync(keyFile, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    const near = BigInt(Math.round(Number(process.env.FACTORY_NEAR ?? '4.5') * 1000)) * 10n ** 21n;
    await as(parent.account_id, parent.private_key).createSubAccount('saku', kp.getPublicKey().toString(), near);
    console.log(`created ${id} with ${Number(near / 10n ** 21n) / 1000} NEAR (key saved to ${keyFile})`);
  }
}
if (!keyFile) throw new Error('Set FACTORY_KEY_FILE (an account you hold) or PARENT_KEY_FILE (to make saku.<parent>).');
const k = read(keyFile);
const factory = as(k.account_id, k.private_key);

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
