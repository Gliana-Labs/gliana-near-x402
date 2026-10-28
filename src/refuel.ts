/**
 * Refuel: turn NEAR into USDC on Base at the agent's Base address, through
 * NEAR Intents (the 1Click API) — so an agent holding only NEAR keeps paying.
 *
 *   1. quote   EXACT_OUTPUT: "deliver this much USDC to <Base address>", priced in wNEAR
 *   2. wrap    NEAR -> wNEAR (wrap.near near_deposit), only what the quote needs
 *   3. deposit ft_transfer the wNEAR to the quote's one-time deposit address
 *   4. track   /v0/status until SUCCESS (USDC delivered) or REFUNDED / FAILED
 *
 * The recipient is not a parameter a model can choose: it is the Base address
 * the payer pays FROM (the allowance contract's, when one is used). A leaked
 * agent key can therefore only move the agent's own NEAR into the address the
 * owner controls — never out to an address of its choosing through this code.
 *
 * Mainnet only: NEAR Intents has no testnet (HACKATHON.md Q-007). `dry: true`
 * quotes cost nothing and move nothing.
 */
import type { Account } from '@near-js/accounts';

export const ONECLICK = 'https://1click.chaindefuser.com';
export const WNEAR = 'nep141:wrap.near';
export const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';

export interface RefuelQuote {
  depositAddress: string | null;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountInUsd: string;
  timeEstimate: number;
  deadline: string;
}

export async function refuelQuote(opts: {
  usdcMicro: bigint;
  recipient: string;
  refundTo: string;
  dry: boolean;
  jwt?: string;
  fetchImpl?: typeof fetch;
}): Promise<RefuelQuote> {
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  const res = await (opts.fetchImpl ?? fetch)(`${ONECLICK}/v0/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.jwt ? { authorization: `Bearer ${opts.jwt}` } : {}) },
    body: JSON.stringify({
      dry: opts.dry,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 100,
      originAsset: WNEAR,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: BASE_USDC,
      amount: opts.usdcMicro.toString(),
      recipient: opts.recipient,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: opts.refundTo,
      refundType: 'ORIGIN_CHAIN',
      deadline,
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { quote?: Record<string, unknown>; message?: string };
  if (!res.ok || !j.quote) throw new Error(`1Click quote refused: ${j.message ?? `HTTP ${res.status}`}`);
  const q = j.quote;
  return {
    depositAddress: (q.depositAddress as string | undefined) ?? null,
    amountIn: String(q.amountIn),
    amountInFormatted: String(q.amountInFormatted),
    amountOut: String(q.amountOut),
    amountInUsd: String(q.amountInUsd),
    timeEstimate: Number(q.timeEstimate ?? 0),
    deadline,
  };
}

export type RefuelStatus = 'SUCCESS' | 'REFUNDED' | 'FAILED' | 'INCOMPLETE_DEPOSIT' | 'TIMEOUT';

/**
 * The whole refuel, from the account that pays in NEAR. One attempt: a deposit
 * that was sent is never re-sent automatically — if the status cannot be read,
 * the deposit address is returned so it can be checked on explorer.near-intents.org.
 */
export async function refuel(opts: {
  account: Account;
  usdcMicro: bigint;
  recipient: string;
  /** Hard ceiling on the NEAR spent, in yoctoNEAR: the quote must fit or nothing is sent. */
  maxNearYocto: bigint;
  jwt?: string;
  onStep?: (msg: string) => void;
  pollMs?: number;
}): Promise<{ status: RefuelStatus; depositAddress: string; amountIn: string }> {
  const step = opts.onStep ?? (() => {});
  const q = await refuelQuote({ usdcMicro: opts.usdcMicro, recipient: opts.recipient, refundTo: opts.account.accountId, dry: false, jwt: opts.jwt });
  if (!q.depositAddress) throw new Error('1Click returned no deposit address.');
  const amountIn = BigInt(q.amountIn);
  if (amountIn > opts.maxNearYocto) throw new Error(`The quote needs ${q.amountInFormatted} NEAR, over the ${Number(opts.maxNearYocto) / 1e24} NEAR ceiling. Nothing was sent.`);
  step(`Quote: ${q.amountInFormatted} NEAR -> ${Number(q.amountOut) / 1e6} USDC on Base to ${opts.recipient} (~${q.timeEstimate}s).`);

  const wrap = 'wrap.near';
  const registered = async (id: string) =>
    (await opts.account.provider.callFunction(wrap, 'storage_balance_of', { account_id: id }).catch(() => null)) !== null;
  for (const id of [opts.account.accountId, q.depositAddress]) {
    if (!(await registered(id))) {
      await opts.account.callFunction({ contractId: wrap, methodName: 'storage_deposit', args: { account_id: id, registration_only: true }, deposit: 1_250_000_000_000_000_000_000n, gas: 30_000_000_000_000n });
    }
  }
  await opts.account.callFunction({ contractId: wrap, methodName: 'near_deposit', args: {}, deposit: amountIn, gas: 30_000_000_000_000n });
  step(`Wrapped ${q.amountInFormatted} NEAR; sending it to the deposit address ${q.depositAddress}.`);
  await opts.account.callFunction({ contractId: wrap, methodName: 'ft_transfer', args: { receiver_id: q.depositAddress, amount: q.amountIn }, deposit: 1n, gas: 30_000_000_000_000n });

  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 5_000));
    const s = (await (await fetch(`${ONECLICK}/v0/status?depositAddress=${encodeURIComponent(q.depositAddress)}`)).json().catch(() => ({}))) as { status?: string };
    if (s.status) step(`  ${s.status}`);
    if (s.status === 'SUCCESS' || s.status === 'REFUNDED' || s.status === 'FAILED' || s.status === 'INCOMPLETE_DEPOSIT') {
      return { status: s.status, depositAddress: q.depositAddress, amountIn: q.amountIn };
    }
  }
  return { status: 'TIMEOUT', depositAddress: q.depositAddress, amountIn: q.amountIn };
}
