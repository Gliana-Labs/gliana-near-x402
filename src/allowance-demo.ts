/**
 * The agent-allowance story in one run, recorded for the demo video:
 *
 *   1. refuel  the agent turns a little NEAR into USDC at the contract's Base address (NEAR Intents)
 *   2. pay     the agent buys an API call; the contract approves, the MPC signs, x402 settles
 *   3. attack  the same agent, hijacked, tries to send $5 to an attacker: refused on chain
 *
 *   AGENT_KEY_FILE=~/.near-gliana/agent.you.near.json ALLOWANCE=allowance.you.near npm run demo:allowance
 *
 * REFUEL_USDC (default 0.1) sets the refuel; SKIP_REFUEL=1 skips it (testnet has no NEAR Intents).
 */
import { readFileSync } from 'node:fs';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import type { Hex } from 'viem';
import { authorizationDigest, payWithNear, randomNonce, type Accept, type NearNetwork } from './x402-payer.js';
import { policySigner } from './policy.js';
import { refuel } from './refuel.js';

const NETWORK = (process.env.NEAR_NETWORK ?? 'mainnet') as NearNetwork;
const ALLOWANCE = process.env.ALLOWANCE;
const KEY_FILE = process.env.AGENT_KEY_FILE;
if (!ALLOWANCE || !KEY_FILE) {
  console.error('Set ALLOWANCE=allowance.<you> and AGENT_KEY_FILE=/path/to/agent-key.json.');
  process.exit(1);
}
const agent = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as { account_id: string; private_key: string };
const provider = new JsonRpcProvider({ url: `https://rpc.${NETWORK}.near.org` });
const policy = (await provider.callFunction(ALLOWANCE, 'get_policy', {})) as {
  owner: string; from: string; per_payment_max: string; daily_limit: string; spent_today: string; payees: string[];
};
const usd = (micro: string | number) => `$${(Number(micro) / 1e6).toFixed(3)}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sign = policySigner({ accountId: agent.account_id, privateKey: agent.private_key, contractId: ALLOWANCE, network: NETWORK, onWait: (m) => console.log(`  ${m}`) });

console.log(`Agent      ${agent.account_id} — its key can only ask the contract`);
console.log(`Allowance  ${ALLOWANCE} (owner ${policy.owner})`);
console.log(`Policy     ${usd(policy.per_payment_max)} per payment, ${usd(policy.daily_limit)} a day, payees: ${policy.payees.map((p) => p.replace(/^0x/, "")).map((p) => `0x${p.slice(0, 4)}…${p.slice(-4)}`).join(', ')}`);
console.log(`Base       0x${policy.from.replace(/^0x/, '')} — held by the contract alone`);
await pause(1500);

if (process.env.SKIP_REFUEL !== '1') {
  const usdc = Number(process.env.REFUEL_USDC ?? 0.1);
  console.log('');
  console.log(`[1] REFUEL  ${usdc} USDC on Base, paid in NEAR through NEAR Intents`);
  const account = new Account(agent.account_id, provider, new KeyPairSigner(KeyPair.fromString(agent.private_key as `ed25519:${string}`)));
  const r = await refuel({ account, usdcMicro: BigInt(Math.round(usdc * 1e6)), recipient: policy.from, maxNearYocto: 10n ** 24n / 2n, onStep: (m) => console.log(`  ${m}`) });
  if (r.status !== 'SUCCESS') {
    console.error(`  ${r.status} — see https://explorer.near-intents.org (deposit ${r.depositAddress}). Stopping.`);
    process.exit(1);
  }
  console.log(`  REFUELED ${usdc} USDC`);
  await pause(1500);
}

console.log('');
console.log('[2] PAY     the agent buys live token prices from GlianaAI over x402');
const paid = await payWithNear({
  url: 'https://api.glianalabs.com/x402/tools/token-price',
  body: { symbols: 'NEAR,ETH', vs: 'usd' },
  from: `0x${policy.from.replace(/^0x/, '')}` as Hex,
  sign,
});
if (paid.status !== 200) {
  console.error(`  NOT PAID — HTTP ${paid.status} ${JSON.stringify(paid.body).slice(0, 300)}`);
  process.exit(1);
}
const prices = (paid.body as { output?: unknown; prices?: unknown })?.output ?? paid.body;
console.log(`  PAID ${usd(paid.chargedMicroUsd ?? 0)} within the allowance`);
console.log(`  ${JSON.stringify(prices).slice(0, 160)}`);
await pause(1500);

console.log('');
console.log('[3] ATTACK  a prompt-injected agent tries to send $5.00 to 0x000…dEaD');
const now = Math.floor(Date.now() / 1000);
const attacker = '0x000000000000000000000000000000000000dEaD' as Hex;
const accept = { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '5000000', payTo: attacker, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' }, maxTimeoutSeconds: 600 } as unknown as Accept;
const auth = { from: `0x${policy.from.replace(/^0x/, '')}` as Hex, to: attacker, value: '5000000', validAfter: String(now - 60), validBefore: String(now + 600), nonce: randomNonce() };
try {
  await sign(authorizationDigest(accept, auth as never), auth as never);
  console.error('  SIGNED — this must never happen');
  process.exit(1);
} catch (err) {
  const why = /Smart contract panicked: ([^"\n]+)/.exec(String((err as Error)?.message ?? err))?.[1] ?? String(err).slice(0, 200);
  console.log(`  REFUSED on chain by ${ALLOWANCE}: ${why}`);
  console.log('  Nothing was signed. A stolen agent key is worth one day\'s budget, to the owner\'s payees only.');
}
const after = (await provider.callFunction(ALLOWANCE, 'get_policy', {})) as { spent_today: string; daily_limit: string };
console.log('');
console.log(`Spent today ${usd(after.spent_today)} of ${usd(after.daily_limit)}`);
