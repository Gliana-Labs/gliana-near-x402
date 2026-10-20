# Pay for AI with a NEAR account

An agent with a NEAR account buys AI inference on
[GlianaAI](https://api.glianalabs.com) — **and no EVM private key exists
anywhere.**

NEAR's Chain Signatures MPC (`v1.signer`: 17 nodes, threshold 11) signs an
arbitrary 32-byte hash on secp256k1. An EIP-3009 `transferWithAuthorization`,
which is how USDC moves on Base without gas, is exactly that — an ECDSA
signature over an EIP-712 digest. So a NEAR account authorises the USDC
transfer directly, and the key for that Base address is a threshold of
validators instead of a file on a disk.

```
derive address   offline, free     accountId + path -> Base address
POST the API                       -> 402: price, payTo, asset
build + hash     offline           EIP-3009 TransferWithAuthorization
v1.signer.sign   ~15s, gas         -> {r, s, v}
POST + X-PAYMENT                   -> 200, USDC moved, answer returned
```

## Try it

```bash
npm install

# Where do I send funds? (no account, no gas, no network call)
npm run address -- example.near

# Buy one call
NEAR_KEY_FILE=key.json npm run demo
```

A key file is `{"account_id": "...", "private_key": "ed25519:..."}`.
`NEAR_NETWORK=testnet` works against a free testnet account.

## This is verified, not theoretical

A real signature from `v1.signer-prod.testnet` **recovers to exactly the
address derived offline**:

```
recovered  0x951Ad1032C9ee0b4e4AcA5b96341033b7f3A3730
derived    0x951Ad1032C9ee0b4e4AcA5b96341033b7f3A3730
```

That MPC response is committed as a test fixture, so if either half of the
chain drifts the build breaks rather than money going somewhere nobody
controls. The payment construction is separately verified against the live
facilitator.

**Measured: a sign call takes ~15 seconds.** Comfortable inside an x402
window (900s), but not interactive — say what you are waiting for.

## What's here

```
src/x402-payer.ts   challenge -> digest -> header. Pure; no key, no network beyond the resource.
src/signer.ts       the only part that costs gas: v1.signer via @near-js.
src/demo.ts         the five steps, end to end.
src/address.ts      print the Base address a NEAR account controls.
skills/pay-with-near/   agent skill in the near/agent-skills format.
```

## Why the seller side needed no changes

GlianaAI already issues and settles Base x402 challenges and does not care
what produced the signature. Everything here is client-side. That is the
point: Chain Signatures makes a NEAR account a first-class buyer on chains it
has no key for, without asking every seller to integrate anything.

MIT.
