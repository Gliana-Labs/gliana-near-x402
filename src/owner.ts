/**
 * What the owner can do from a terminal; the web app in web/ does the same from a wallet.
 *
 *   OWNER_KEY_FILE=~/.near-gliana/you.json ALLOWANCE=allowance.you.near npm run allowance:owner -- list
 *   ... -- approve 3 | reject 3 | revoke | add-payee 0xabc... | remove-payee 0xabc...
 *   ... -- fund 0.2   sends that much NEAR from the owner to the contract, which pays for its storage
 */
import { readFileSync } from 'node:fs';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { rpcUrl, type NearNetwork } from './x402-payer.js';

const ALLOWANCE = process.env.ALLOWANCE;
const KEY_FILE = process.env.OWNER_KEY_FILE;
const NETWORK = (process.env.NEAR_NETWORK ?? 'mainnet') as NearNetwork;
const [what, arg] = process.argv.slice(2);
if (!ALLOWANCE || !what) {
  console.error('Set ALLOWANCE, and say list, approve <id>, reject <id>, revoke, add-payee <0x...> or remove-payee <0x...>.');
  process.exit(1);
}
const provider = new JsonRpcProvider({ url: rpcUrl(NETWORK) });
if (what === 'list') {
  console.log(JSON.stringify(await provider.callFunction(ALLOWANCE, 'list_held', {}), null, 2));
  process.exit(0);
}
if (!KEY_FILE) {
  console.error('Set OWNER_KEY_FILE for anything that changes the contract.');
  process.exit(1);
}
const owner = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as { account_id: string; private_key: string };
const account = new Account(owner.account_id, provider, new KeyPairSigner(KeyPair.fromString(owner.private_key as `ed25519:${string}`)));
const call = (methodName: string, args: object, deposit = 1n) => account.callFunction({ contractId: ALLOWANCE, methodName, args, gas: 300_000_000_000_000n, deposit });
if (what === 'approve') await call('approve', { id: arg });
else if (what === 'reject') await call('reject', { id: arg });
else if (what === 'revoke') await call('revoke', {});
else if (what === 'fund') await account.transfer({ receiverId: ALLOWANCE, amount: BigInt(Math.round(Number(arg) * 1e6)) * 10n ** 18n });
else if (what === 'add-payee') await call('add_payee', { payee: arg }, 0n);
else if (what === 'remove-payee') await call('remove_payee', { payee: arg }, 0n);
else {
  console.error(`Unknown: ${what}`);
  process.exit(1);
}
console.log(`${what} ${arg ?? ''} done on ${ALLOWANCE}`);
