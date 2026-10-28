/**
 * Pay through the allowance contract: the agent's key asks, the contract checks
 * the owner's policy and has the MPC sign. Same five steps as demo.ts, with the
 * budget enforced on NEAR in the middle.
 *
 *   AGENT_KEY_FILE=~/.near-gliana/agent.you.near.json ALLOWANCE=allowance.you.near npm run allowance:pay
 */
import { readFileSync } from 'node:fs';
import { payWithNear, deriveEvmAddress, type NearNetwork } from './x402-payer.js';
import { policySigner } from './policy.js';

const NETWORK = (process.env.NEAR_NETWORK ?? 'mainnet') as NearNetwork;
const PATH = process.env.NEAR_PATH ?? 'gliana-x402';
const URL = process.env.GLIANA_URL ?? 'https://api.glianalabs.com/x402/tools/token-price';
const BODY = JSON.parse(process.env.GLIANA_BODY ?? '{"symbols":"NEAR,SOL","vs":"usd"}');
const ALLOWANCE = process.env.ALLOWANCE;
const KEY_FILE = process.env.AGENT_KEY_FILE;
if (!ALLOWANCE || !KEY_FILE) {
  console.error('Set ALLOWANCE=allowance.<you> and AGENT_KEY_FILE=/path/to/agent-key.json.');
  process.exit(1);
}
const agent = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as { account_id: string; private_key: string };
const from = await deriveEvmAddress(ALLOWANCE, PATH, NETWORK);

console.log(`Agent        : ${agent.account_id}  (${NETWORK}) — its key can only ask`);
console.log(`Allowance    : ${ALLOWANCE}  — holds the Base address, enforces the budget`);
console.log(`Base address : ${from}`);
console.log(`Buying       : ${URL}`);
console.log('');

try {
  const result = await payWithNear({
    url: URL,
    body: BODY,
    from,
    sign: policySigner({ accountId: agent.account_id, privateKey: agent.private_key, contractId: ALLOWANCE, network: NETWORK, onWait: (m) => console.log(`  ${m}`) }),
  });
  console.log('');
  if (result.status === 200) {
    console.log(`PAID ${result.chargedMicroUsd} microUSD on ${result.network}, within the allowance`);
    console.log(JSON.stringify(result.body, null, 2).slice(0, 800));
  } else {
    console.error(`NOT PAID — HTTP ${result.status}`);
    console.error(JSON.stringify(result.body, null, 2).slice(0, 600));
    process.exit(1);
  }
} catch (err) {
  // A policy refusal arrives here as the contract's own panic message.
  const msg = String((err as Error).message ?? err);
  const why = /Smart contract panicked: ([^"\n]+)/.exec(msg)?.[1] ?? msg.slice(0, 300);
  console.error(`REFUSED by the allowance: ${why}`);
  process.exit(1);
}
