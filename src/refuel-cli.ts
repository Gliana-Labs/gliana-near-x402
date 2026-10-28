/**
 * Refuel the agent's Base address with USDC, paid in NEAR through NEAR Intents.
 *
 *   NEAR_KEY_FILE=~/.near-gliana/agent.you.near.json ALLOWANCE=allowance.you.near npm run refuel -- 1
 *
 * The number is USDC to deliver (default 1). The Base address is the allowance's
 * (ALLOWANCE) or, without one, the account's own. DRY=1 prints the quote and sends nothing.
 * MAX_NEAR caps the NEAR spent (default 1): a quote that needs more is refused before anything is sent.
 */
import { readFileSync } from 'node:fs';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { deriveEvmAddress } from './x402-payer.js';
import { refuel, refuelQuote } from './refuel.js';

const usdc = Number(process.argv[2] ?? 1);
if (!(usdc > 0 && usdc <= 100)) {
  console.error('USDC to deliver: a number from 0.01 to 100.');
  process.exit(1);
}
const keyFile = process.env.NEAR_KEY_FILE;
if (!keyFile) {
  console.error('Set NEAR_KEY_FILE (the NEAR account that pays, e.g. the agent).');
  process.exit(1);
}
const key = JSON.parse(readFileSync(keyFile, 'utf8')) as { account_id: string; private_key: string };
const provider = new JsonRpcProvider({ url: 'https://rpc.mainnet.near.org' });
const recipient = process.env.ALLOWANCE
  ? ((await provider.callFunction(process.env.ALLOWANCE, 'get_policy', {})) as { from: string }).from
  : await deriveEvmAddress(key.account_id, process.env.NEAR_PATH ?? 'gliana-x402', 'mainnet');
const usdcMicro = BigInt(Math.round(usdc * 1e6));

if (process.env.DRY === '1') {
  const q = await refuelQuote({ usdcMicro, recipient, refundTo: key.account_id, dry: true, jwt: process.env.ONECLICK_JWT });
  console.log(`DRY: ${q.amountInFormatted} NEAR (~$${Number(q.amountInUsd).toFixed(3)}) -> ${usdc} USDC on Base to ${recipient}, ~${q.timeEstimate}s. Nothing sent.`);
  process.exit(0);
}

const account = new Account(key.account_id, provider, new KeyPairSigner(KeyPair.fromString(key.private_key as `ed25519:${string}`)));
const maxNear = BigInt(Math.round(Number(process.env.MAX_NEAR ?? 1) * 1e6)) * 10n ** 18n;
const r = await refuel({ account, usdcMicro, recipient, maxNearYocto: maxNear, jwt: process.env.ONECLICK_JWT, onStep: (m) => console.log(m) });
console.log(r.status === 'SUCCESS' ? `REFUELED: ${usdc} USDC delivered to ${recipient}` : `${r.status} — check https://explorer.near-intents.org (deposit ${r.depositAddress})`);
process.exit(r.status === 'SUCCESS' ? 0 : 1);
