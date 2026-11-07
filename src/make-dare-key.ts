/**
 * Makes the key the owner page publishes on purpose: a NEW key on the TESTNET agent, able to call only `pay` on the
 * testnet allowance, with a small gas allowance. Anyone may use it. It holds no money and can't move any.
 * Testnet only, and it refuses anything else. Writes web/src/dare-key.ts.
 *
 *   AGENT_KEY_FILE=~/.near-gliana/agent.gliana-x402.testnet.json ALLOWANCE=allowance.gliana-x402.testnet npx tsx src/make-dare-key.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { rpcUrl } from './x402-payer.js';

const agent = JSON.parse(readFileSync(process.env.AGENT_KEY_FILE!, 'utf8')) as { account_id: string; private_key: string };
const allowance = process.env.ALLOWANCE!;
if (!agent.account_id.endsWith('.testnet') || !allowance.endsWith('.testnet')) throw new Error('Testnet only: this key is published.');
const provider = new JsonRpcProvider({ url: rpcUrl('testnet') });
const account = new Account(agent.account_id, provider, new KeyPairSigner(KeyPair.fromString(agent.private_key as `ed25519:${string}`)));
const key = KeyPair.fromRandom('ed25519');
await account.addFunctionCallAccessKey({ publicKey: key.getPublicKey().toString(), contractId: allowance, methodNames: ['pay'], allowance: 2n * 10n ** 24n });
writeFileSync(
  'web/src/dare-key.ts',
  `// Published on purpose (src/make-dare-key.ts): a testnet key that can only ask the testnet allowance contract for a payment.\n// It holds no money and can't move any. Nothing here works on mainnet.\nexport const DARE = { network: 'testnet', account: '${agent.account_id}', contract: '${allowance}', key: '${key.toString()}' } as const;\n`,
);
console.log('added a pay-only key to', agent.account_id, key.getPublicKey().toString().slice(0, 24) + '…');
