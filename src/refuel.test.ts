import { describe, expect, it, vi } from 'vitest';
import { BASE_USDC, refuel, refuelQuote, WNEAR } from './refuel.js';

const quoteResponse = (amountIn: string) =>
  new Response(JSON.stringify({ quote: { depositAddress: 'deposit.near', amountIn, amountInFormatted: '0.2155', amountOut: '1000000', amountInUsd: '1.03', timeEstimate: 22 } }));

describe('refuel', () => {
  it('asks NEAR Intents for exactly that much USDC on Base, to the given address, paid in wNEAR', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => ((sent = JSON.parse(String(init.body))), quoteResponse('215505606948787281060059')));
    const q = await refuelQuote({ usdcMicro: 1_000_000n, recipient: '0xe32847B59D97cF36915D92064B99543743A88493', refundTo: 'agent.near', dry: true, fetchImpl: fetchImpl as never });
    expect(sent).toMatchObject({ dry: true, swapType: 'EXACT_OUTPUT', originAsset: WNEAR, destinationAsset: BASE_USDC, amount: '1000000', recipient: '0xe32847B59D97cF36915D92064B99543743A88493', recipientType: 'DESTINATION_CHAIN', refundTo: 'agent.near' });
    expect(q.amountIn).toBe('215505606948787281060059');
  });

  it('sends nothing when the quote is over the NEAR ceiling', async () => {
    vi.stubGlobal('fetch', async () => quoteResponse(String(2n * 10n ** 24n)));
    const callFunction = vi.fn();
    const account = { accountId: 'agent.near', callFunction, provider: { callFunction: vi.fn() } } as never;
    await expect(refuel({ account, usdcMicro: 1_000_000n, recipient: '0xe32847B59D97cF36915D92064B99543743A88493', maxNearYocto: 10n ** 24n })).rejects.toThrow(/over the 1 NEAR ceiling. Nothing was sent/);
    expect(callFunction).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
