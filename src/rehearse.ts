/**
 * Runs the owner-approval, new-payee and revoke rules against a live contract on testnet, end to end, with the real MPC.
 * Free: testnet only, and it refuses anything else.
 *
 *   NEAR_NETWORK=testnet ALLOWANCE=allowance.you.testnet AGENT_KEY_FILE=... OWNER_KEY_FILE=... npx tsx src/rehearse.ts
 */
import { readFileSync } from 'node:fs';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { recoverAddress, type Hex } from 'viem';
import { policySigner } from './policy.js';
import { authorizationDigest, randomNonce, rpcUrl, type Accept } from './x402-payer.js';

if (process.env.NEAR_NETWORK !== 'testnet') throw new Error('Testnet only.');
const ALLOWANCE = process.env.ALLOWANCE!;
const load = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as { account_id: string; private_key: string };
const agent = load(process.env.AGENT_KEY_FILE!);
const owner = load(process.env.OWNER_KEY_FILE!);
const provider = new JsonRpcProvider({ url: rpcUrl('testnet') });
const ownerAccount = new Account(owner.account_id, provider, new KeyPairSigner(KeyPair.fromString(owner.private_key as `ed25519:${string}`)));
const asOwner = (methodName: string, args: Record<string, unknown>, deposit = 1n) => ownerAccount.callFunction({ contractId: ALLOWANCE, methodName, args, gas: 300_000_000_000_000n, deposit });
const view = (m: string, a: Record<string, unknown> = {}) => provider.callFunction(ALLOWANCE, m, a) as Promise<any>;
const policy = await view('get_policy');
const from = policy.from as Hex;
const seller = policy.payees[0] as Hex;
const sign = policySigner({ accountId: agent.account_id, privateKey: agent.private_key, contractId: ALLOWANCE, network: 'testnet', onWait: (m) => console.log(`  ${m}`) });
const auth = (to: Hex, value: string) => {
  const now = Math.floor(Date.now() / 1000);
  return { from, to, value, validAfter: String(now - 60), validBefore: String(now + 600), nonce: randomNonce() };
};
const accept = (to: Hex, value: string) => ({ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: value, payTo: to, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' }, maxTimeoutSeconds: 600 }) as unknown as Accept;
const recovered = async (digest: Hex, s: { r: Hex; s: Hex; v: number }) => (await recoverAddress({ hash: digest, signature: { r: s.r, s: s.s, v: BigInt(s.v) } })).toLowerCase();
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) process.exitCode = 1;
};

console.log(`policy: approval_max ${policy.approval_max}, payee_delay_s ${policy.payee_delay_s}, per_payment_max ${policy.per_payment_max}`);

// 1. Inside the rules: signed straight away, by the same address as before.
{
  const a = auth(seller, '2000');
  const d = authorizationDigest(accept(seller, '2000'), a as never);
  const s = (await sign(d, a as never)) as never;
  check((await recovered(d, s)) === from.toLowerCase(), 'an ordinary payment is signed by the contract\'s Base address');
}

// 2. Unusual: held, and the owner approves. Runs alongside the waiting agent, as it would in life.
{
  const a = auth(seller, '20000');
  const d = authorizationDigest(accept(seller, '20000'), a as never);
  const signing = sign(d, a as never) as Promise<never>;
  let id: string | undefined;
  for (let i = 0; i < 20 && !id; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    id = ((await view('list_held')) as { id: string; status: string }[]).find((h) => h.status === 'waiting')?.id;
  }
  check(Boolean(id), 'a payment over the cap waits instead of being signed');
  const before = (await view('get_policy')).spent_today;
  await asOwner('approve', { id });
  const s = await signing;
  check((await recovered(d, s)) === from.toLowerCase(), 'after the owner approves, the agent gets a real signature');
  check((await view('get_policy')).spent_today === before, 'an approved payment doesn\'t use up the agent\'s budget');
}

// 3. The owner rejects: the agent is told, and nothing is signed.
{
  const a = auth(seller, '20000');
  const d = authorizationDigest(accept(seller, '20000'), a as never);
  const signing = (sign(d, a as never) as Promise<unknown>).then(() => 'signed', (e) => String(e));
  let id: string | undefined;
  for (let i = 0; i < 20 && !id; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    id = ((await view('list_held')) as { id: string; status: string }[]).find((h) => h.status === 'waiting')?.id;
  }
  await asOwner('reject', { id });
  check(/rejected/.test(await signing), 'a rejected payment comes back refused');
}

// 4. A new payee has to wait.
{
  const fresh = '0x2222222222222222222222222222222222222222' as Hex;
  await asOwner('add_payee', { payee: fresh }, 0n);
  const a = auth(fresh, '2000');
  const why = await view('check', { agent: agent.account_id, to: fresh, value: '2000', valid_after: a.validAfter, valid_before: a.validBefore });
  check(/added recently/.test(String(why)), `a new payee waits: ${why}`);
  await asOwner('remove_payee', { payee: fresh }, 0n);
}

// 5. Revoke cuts the agent off, and coming back takes a new agent.
{
  await asOwner('revoke', {});
  const a = auth(seller, '2000');
  const why = await view('check', { agent: agent.account_id, to: seller, value: '2000', valid_after: a.validAfter, valid_before: a.validBefore });
  check(/paused/.test(String(why)), `revoked: ${why}`);
  await asOwner('set_agent', { agent: agent.account_id }, 0n);
  await asOwner('set_paused', { paused: false }, 0n);
  check((await view('get_policy')).paused === false, 'the owner can bring it back with an agent they choose');
}

// 6. The history is on the contract, refusals included.
const history = (await view('get_history')) as { what: string }[];
console.log(`history: ${history.map((h) => h.what).reverse().join(' → ')}`);
check(['signed', 'held', 'approved', 'rejected', 'payee_added', 'revoked'].every((w) => history.some((h) => h.what === w)), 'every decision is in the on-chain history');
