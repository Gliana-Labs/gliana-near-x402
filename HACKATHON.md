# NEAR HACKATHON — Agent Economy (track 07)

**An AI agent pays for APIs with a NEAR account. No EVM private key exists.**

## The problem

`nearai/near-mcp` — NEAR's own MCP server — is local-only, and the repo says
why: it handles private keys, so there is no hosted public version.

That is the shape of the whole problem. An agent that spends money has to hold
a key, and a key is the thing you cannot hand to an agent, a container, or a
hosted service.

Chain Signatures removes it. The agent holds a NEAR account; the key for every
other chain is a threshold of 11 out of 17 NEAR validators.

## What was built

A client that turns a NEAR account into a buyer on Base:

```
derive address   offline, free     accountId + path -> Base address
POST the API                       -> 402: price, payTo, asset
build + hash     offline           EIP-3009 TransferWithAuthorization
v1.signer.sign   ~15s, gas         -> {r, s, v}
POST + X-PAYMENT                   -> 200, USDC moved, answer returned
```

The insight is that these are the same object. `v1.signer` signs an arbitrary
32-byte hash on secp256k1. EIP-3009 `transferWithAuthorization` — how USDC is
spent gaslessly on Base — is an ECDSA signature over an EIP-712 digest. So a
NEAR account can authorise a USDC transfer on a chain it has no key for.

## What it buys

[GlianaAI](https://api.glianalabs.com): 128 AI models and 60+ tools sold per
call, no account, no API key, a 402 is the only gate. Prices from $0.002. It
is a live business with 364 settled x402 transactions, not a demo endpoint.

**The seller needed zero changes.** It already issues and settles Base
challenges and does not care what produced the signature. That is the claim
worth making: Chain Signatures makes NEAR accounts first-class buyers on
other chains *without asking any seller to integrate anything*.

## Verified, not asserted

**The MPC signature recovers to the address derived offline:**

```
recovered  0x951Ad1032C9ee0b4e4AcA5b96341033b7f3A3730
derived    0x951Ad1032C9ee0b4e4AcA5b96341033b7f3A3730
```

Real reply from `v1.signer-prod.testnet`, committed as a test fixture.

**Address derivation matches `chainsig.js`** on three vectors — implemented
with `@noble` alone, avoiding its bitcoin/cosmos/sui/xrpl/aptos/solana bundle.

**Payment construction verified against the live facilitator:** a structurally
perfect payment with a deliberately fake signature is rejected with
`invalid signature: not for a valid curve point` — i.e. everything but the
signature is confirmed correct end to end.

**Measured: 15.2s per MPC signature.** Fine inside a 900s x402 window; not
interactive. Stated plainly because a demo that hides it is lying.

## Honest limits

- **Solana is refused, with a reason.** Its `exact` scheme signs a serialized
  transaction, not an EIP-712 digest. Possible with the same primitive, but a
  different construction, and half-shipping it behind the same function would
  be worse than saying no.
- **15 seconds is slow.** It buys a key that does not exist. Whether that
  trade is worth it depends on what the agent is.
- **One attempt, never an automatic retry.** The nonce is single-use, and a
  retry after a settled payment pays twice for one answer.

## Running it

```bash
npm install
npm run address -- example.near          # free, offline
NEAR_KEY_FILE=key.json npm run demo      # buys one call
```

`NEAR_NETWORK=testnet` works against a free testnet account, which is how
everything above was measured.
