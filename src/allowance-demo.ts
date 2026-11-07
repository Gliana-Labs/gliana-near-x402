/**
 * The agent-allowance story in one run, recorded for the demo video:
 *
 *   1. refuel  the agent turns a little NEAR into USDC at the contract's Base address (NEAR Intents)
 *   2. pay     the agent buys a call from Exa, a seller that has never heard of us: the contract approves, the MPC signs, x402 settles
 *   3. held    the agent wants an image over its per-payment limit: nothing is signed until the owner approves it
 *   4. attack  the same agent, hijacked, tries to send $5 to an attacker: refused on chain
 *
 *   AGENT_KEY_FILE=~/.near-gliana/agent.you.near.json ALLOWANCE=allowance.you.near npm run demo:allowance
 *
 * REFUEL_USDC (default 0.1) sets the refuel; SKIP_REFUEL=1 skips it (testnet has no NEAR Intents);
 * SKIP_PAY=1 skips the paid call and SKIP_HELD=1 the one that waits for the owner, so the run can cost nothing
 * (the refusal sends no transaction).
 */
import { readFileSync } from 'node:fs';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import type { Hex } from 'viem';
import { authorizationDigest, payWithNear, randomNonce, rpcUrl, type Accept, type NearNetwork } from './x402-payer.js';
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
const provider = new JsonRpcProvider({ url: rpcUrl(NETWORK as NearNetwork) });
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

if (process.env.SKIP_PAY !== '1') {
console.log('');
console.log('[2] PAY     the agent buys a page from Exa, a seller that changed nothing for this');
const paid = await payWithNear({
  url: 'https://api.exa.ai/contents',
  body: { urls: ['https://near.org'], text: { maxCharacters: 120 } },
  from: `0x${policy.from.replace(/^0x/, '')}` as Hex,
  sign,
});
if (paid.status !== 200) {
  console.error(`  NOT PAID — HTTP ${paid.status} ${JSON.stringify(paid.body).slice(0, 300)}`);
  process.exit(1);
}
const page = (paid.body as { results?: { title?: string; text?: string }[] })?.results?.[0];
console.log(`  PAID ${usd(paid.chargedMicroUsd ?? 0)} within the allowance`);
console.log(`  ${JSON.stringify({ title: page?.title, text: page?.text }).slice(0, 160)}`);
await pause(1500);
}

if (process.env.SKIP_HELD !== '1') {
console.log('');
console.log(`[3] HELD    the agent wants an image, over its ${usd(policy.per_payment_max)} limit: it waits for the owner`);
const image = await payWithNear({
  url: 'https://api.glianalabs.com/x402/krea-2-medium-turbo',
  body: { prompt: 'a small brass pocket with a coin in it, studio light', aspect_ratio: '1:1' },
  from: `0x${policy.from.replace(/^0x/, '')}` as Hex,
  sign,
});
if (image.status !== 200) {
  console.error(`  NOT PAID — HTTP ${image.status} ${JSON.stringify(image.body).slice(0, 300)}`);
  process.exit(1);
}
console.log(`  PAID ${usd(image.chargedMicroUsd ?? 0)} after the owner approved it`);
console.log(`  ${JSON.stringify((image.body as { output?: unknown })?.output ?? image.body).slice(0, 160)}`);
await pause(1500);
}

console.log('');
console.log('[4] ATTACK  a prompt-injected agent tries to send $5.00 to 0x000…dEaD');
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
  console.log(`  REFUSED by ${ALLOWANCE}: ${why}`);
  console.log('  Refused by the contract\'s own check before any transaction: nothing sent, nothing signed.');
}
const after = (await provider.callFunction(ALLOWANCE, 'get_policy', {})) as { spent_today: string; daily_limit: string };
console.log('');
console.log(`Spent today ${usd(after.spent_today)} of ${usd(after.daily_limit)}`);
