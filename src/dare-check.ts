/** Proves the published key can do what the page says and nothing more. Testnet, free. */
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { DARE } from '../web/src/dare-key.js';
import { rpcUrl } from './x402-payer.js';

const provider = new JsonRpcProvider({ url: rpcUrl('testnet') });
const thief = new Account(DARE.account, provider, new KeyPairSigner(KeyPair.fromString(DARE.key as `ed25519:${string}`)));
const now = Math.floor(Date.now() / 1000);
const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const answer = await thief.callFunction({ contractId: DARE.contract, methodName: 'pay', args: { to: '0x000000000000000000000000000000000000dEaD', value: '5000000', valid_after: String(now - 60), valid_before: String(now + 600), nonce }, gas: 300_000_000_000_000n, deposit: 0n });
console.log('steal $5 with the key:', JSON.stringify(answer));
for (const [what, run] of [
  ['transfer NEAR away', () => thief.transfer({ receiverId: 'gliana-x402.testnet', amount: 10n ** 22n })],
  ['call another method (add a seller)', () => thief.callFunction({ contractId: DARE.contract, methodName: 'add_payee', args: { payee: '0x000000000000000000000000000000000000dEaD' }, gas: 30_000_000_000_000n, deposit: 0n })],
  ['pay from a different contract', () => thief.callFunction({ contractId: 'v1.signer-prod.testnet', methodName: 'sign', args: {}, gas: 30_000_000_000_000n, deposit: 1n })],
] as const) {
  const out = await run().then(() => 'ALLOWED — this must never happen', (e) => `refused: ${String((e as Error).message ?? e).slice(0, 90)}`);
  console.log(`${what}:`, out);
}
const seller = (await provider.callFunction(DARE.contract, 'get_policy', {}) as { payees: string[] }).payees[0];
const n2 = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const honest = await thief.callFunction({ contractId: DARE.contract, methodName: 'pay', args: { to: seller, value: '2000', valid_after: String(now - 60), valid_before: String(now + 600), nonce: n2 }, gas: 300_000_000_000_000n, deposit: 0n }) as { big_r?: unknown };
console.log('$0.002 to a listed seller, no deposit:', honest?.big_r ? 'signed' : JSON.stringify(honest));
