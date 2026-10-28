---
name: pay-with-near
description: Let an agent buy paid HTTP APIs with a NEAR account, using Chain Signatures to sign EIP-3009 USDC payments on Base. Use when an agent needs to pay for an x402 resource, fund itself without holding an EVM private key, or call GlianaAI's 128 AI models and 60+ tools.
---

# Paying for APIs with a NEAR account

An agent with a NEAR account can buy anything behind an x402 paywall, without
an EVM private key existing anywhere.

NEAR's MPC network (`v1.signer`, 17 nodes, threshold 11) signs an arbitrary
32-byte hash on secp256k1. An EIP-3009 `transferWithAuthorization` — how USDC
is spent on Base without gas — is exactly that: an ECDSA signature over an
EIP-712 digest. So the NEAR account authorises the USDC transfer, and the key
for that Base address is a threshold of validators rather than a file.

## The flow

```
derive address   (offline, free)   accountId + path -> Base address
POST the API                       -> 402 with price, payTo, asset
build + hash     (offline)         EIP-3009 TransferWithAuthorization
v1.signer.sign   (~15s, gas)       -> {r, s, v}
POST again with X-PAYMENT          -> 200 + the answer, USDC moved
```

## Quick start

| Need | Do |
|------|-----|
| Find where to send funds | `npm run address -- your.near` |
| Buy one call | `NEAR_KEY_FILE=key.json npm run demo` |
| Pick a different API | set `GLIANA_URL` and `GLIANA_BODY` |
| Test without mainnet | `NEAR_NETWORK=testnet` |

## Rules that cost money if broken

**The path is the address.** `deriveEvmAddress(account, path)` returns a
different address for every path string. Reuse the same path or the funds sit
at an address the agent no longer looks at. Pick one and write it down.

**Never retry a failed payment automatically.** The EIP-3009 nonce is
single-use, so a retry needs a fresh authorization — and if the first one did
settle, retrying pays twice for one answer. `payWithNear` makes exactly one
attempt and returns the digest so the caller can reconcile first.

**Signing takes about 15 seconds.** Measured against `v1.signer-prod.testnet`.
That is comfortable inside an x402 window (900s) but it is not interactive.
Tell the user what is happening; do not put it behind a 10s timeout.

**The EIP-712 domain comes from the 402, not from a constant.** The challenge
carries the token's own `extra: {name, version}`. A domain that disagrees with
the contract produces a signature that recovers to a different address and is
rejected with no useful error.

**Only EVM `exact` options can be paid this way.** Solana's `exact` scheme
signs a serialized transaction rather than an EIP-712 digest. The payer refuses
a Solana-only challenge with a reason instead of signing the wrong thing.

## What is on the other end

GlianaAI (`api.glianalabs.com`) sells 100+ AI models and 60+ utility tools
per call, with no account and no API key — a 402 is the only gate. Prices
start at $0.002. Full catalogue at `/v1/models` and `/v1/tools`; every paid
endpoint self-describes in `/openapi.json`.

The same payer works against any x402 resource that offers an EVM `exact`
option; GlianaAI is just the one this repo demos.

## References

- `references/payment-flow.md` — each step, with the exact bytes
- `references/troubleshooting.md` — what each failure actually means
