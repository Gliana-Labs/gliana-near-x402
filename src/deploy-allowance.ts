/**
 * Set up an agent allowance under your NEAR account:
 *
 *   allowance.<you>   the contract (contract/src/lib.rs) — it holds the agent's Base address
 *   agent.<you>       the agent's own account — its key can only call allowance.pay
 *
 * New keys are written to ~/.near-gliana/ (mode 600, outside the repo) and never printed.
 * Re-running is safe: existing accounts are reused, and an initialised contract is left as it is.
 *
 *   NEAR_KEY_FILE=~/.near-gliana/you.json NEAR_NETWORK=testnet npm run allowance:deploy
 *
 * Policy (micro-USDC, 1 USDC = 1,000,000): PER_PAYMENT_MAX (default 10000 = $0.01),
 * DAILY_LIMIT (default 50000 = $0.05), PAYEES (comma-separated, default GlianaAI's Base payTo).
 * Funding from the owner: ALLOWANCE_NEAR (default 2.2, mostly contract storage), AGENT_NEAR (default 1).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { deriveEvmAddress, type NearNetwork } from './x402-payer.js';

const NETWORK = (process.env.NEAR_NETWORK ?? 'testnet') as NearNetwork;
const SIGNER = NETWORK === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet';
const PATH = process.env.NEAR_PATH ?? 'gliana-x402';
const PER_PAYMENT_MAX = process.env.PER_PAYMENT_MAX ?? '10000';
const DAILY_LIMIT = process.env.DAILY_LIMIT ?? '50000';
const PAYEES = (process.env.PAYEES ?? '0x7662E00f8Ab4C362166e1FF649Ff6c2A638c80AD').split(',').map((p) => p.trim()).filter(Boolean);
const WASM = 'contract/target/near/agent_allowance.wasm';
const KEYS = join(homedir(), '.near-gliana');

const keyFile = process.env.NEAR_KEY_FILE;
if (!keyFile) {
  console.error('Set NEAR_KEY_FILE=/path/to/owner-key.json ({"account_id":"…","private_key":"ed25519:…"}).');
  process.exit(1);
}
const owner = JSON.parse(readFileSync(keyFile, 'utf8')) as { account_id: string; private_key: string };
const provider = new JsonRpcProvider({ url: `https://rpc.${NETWORK}.near.org` });
const as = (id: string, key: string) => new Account(id, provider, new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)));
const ownerAccount = as(owner.account_id, owner.private_key);

async function exists(id: string): Promise<boolean> {
  try {
    await provider.viewAccount(id);
    return true;
  } catch {
    return false;
  }
}

/** A sub-account with its own new key, saved owner-only. */
async function subAccount(prefix: string, near: bigint): Promise<{ id: string; key: string }> {
  const id = `${prefix}.${owner.account_id}`;
  const path = join(KEYS, `${id}.json`);
  if (existsSync(path)) {
    const k = JSON.parse(readFileSync(path, 'utf8')) as { private_key: string };
    if (await exists(id)) return { id, key: k.private_key };
  }
  if (await exists(id)) throw new Error(`${id} exists but its key is not in ${path}; use another NEAR_PATH prefix or restore the key.`);
  const kp = KeyPair.fromRandom('ed25519');
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  // Written before the account exists, so a crash never leaves an account whose key is lost.
  writeFileSync(path, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600, flag: 'w' });
  await ownerAccount.createSubAccount(prefix, kp.getPublicKey().toString(), near);
  console.log(`created ${id} (key saved to ${path})`);
  return { id, key: kp.toString() };
}

const NEAR = 10n ** 24n;
const near = (v: string | undefined, dflt: string) => BigInt(Math.round(Number(v ?? dflt) * 1000)) * 10n ** 21n;
// Contract storage is 1 NEAR per 100 KB: the 175 KB wasm locks ~1.76 NEAR, given back if the account is deleted.
const allowance = await subAccount('allowance', near(process.env.ALLOWANCE_NEAR, '2.2'));
// 300 TGas is reserved at a pessimistic price per pay (~0.31 NEAR, mostly refunded), plus NEAR to refuel with.
const agent = await subAccount('agent', near(process.env.AGENT_NEAR, '1'));
const from = await deriveEvmAddress(allowance.id, PATH, NETWORK);

const contract = as(allowance.id, allowance.key);
let initialised = false;
try {
  await provider.callFunction(allowance.id, 'get_policy', {});
  initialised = true;
} catch {
  /* no contract, or not initialised */
}
if (!initialised) {
  await contract.deployContract(readFileSync(WASM));
  await contract.callFunction({
    contractId: allowance.id,
    methodName: 'new',
    args: { owner: owner.account_id, agent: agent.id, signer: SIGNER, path: PATH, from, per_payment_max: PER_PAYMENT_MAX, daily_limit: DAILY_LIMIT, payees: PAYEES },
    gas: 100_000_000_000_000n,
  });
  console.log(`deployed and initialised ${allowance.id}`);
}

console.log('');
console.log(`network        : ${NETWORK} (signer ${SIGNER})`);
console.log(`owner          : ${owner.account_id}`);
console.log(`allowance      : ${allowance.id}`);
console.log(`agent          : ${agent.id}   key in ${join(KEYS, `${agent.id}.json`)}`);
console.log(`Base address   : ${from}   <- controlled by the contract alone; fund it with USDC on Base`);
console.log(JSON.stringify(await provider.callFunction(allowance.id, 'get_policy', {}), null, 2));
