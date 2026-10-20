# The payment, step by step

## 1. Derive the address (offline, free, no account needed)

The MPC publishes one root public key. Each `(accountId, path)` shifts it by a
scalar derived from those two strings:

```
epsilon = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + accountId + "," + path)
P_child = P_root + epsilon*G
address = last 20 bytes of keccak256(P_child without its 0x04 tag)
```

`sha3_256`, **not** keccak256 — they differ only in padding, and the wrong one
silently yields a valid-looking address for a key nobody holds. The `0x04`
SEC1 tag is excluded from the hashed input.

Verified against `chainsig.js`'s own `deriveChildPublicKey` on three vectors.

## 2. Read the challenge

```json
{ "x402Version": 1,
  "accepts": [{ "scheme": "exact", "network": "base",
                "maxAmountRequired": "2000",
                "payTo": "0x...", "asset": "0x833589fC...",
                "maxTimeoutSeconds": 900,
                "extra": { "name": "USD Coin", "version": "2" } }] }
```

`maxAmountRequired` is in the asset's smallest unit — 2000 = $0.002 USDC.

## 3. Build and hash

`validAfter` is backdated 60 seconds. Facilitators compare it against *their*
clock, and a signature stamped "valid from now" loses to a node a few seconds
behind — which fails looking like a bad signature, not a clock difference.

The nonce is 32 random bytes. EIP-3009 nonces are arbitrary and single-use; the
token contract records each one.

## 4. Sign

```
contract  v1.signer            (mainnet) / v1.signer-prod.testnet
method    sign
args      { request: { payload_v2: { Ecdsa: "<64 hex, no 0x>" },
                       path: "<your path>", domain_id: 0 } }
gas       300 TGas   (the per-call maximum; less fails late)
deposit   1 yoctoNEAR
```

`domain_id: 0` is secp256k1. `1` is Eddsa and is not what EIP-3009 verifies.

Returns:

```json
{ "scheme": "Secp256k1",
  "big_r": { "affine_point": "03e09c88...0c95" },
  "s": { "scalar": "141d56e2...51d6" },
  "recovery_id": 0 }
```

**`big_r.affine_point` is a COMPRESSED point** — a 02/03 parity prefix then x.
ECDSA's `r` IS that x, so the prefix byte is dropped. Keeping it shifts every
later byte and recovers a different address.

`recovery_id` is 0/1; EIP-3009 wants v 27/28.

## 5. Pay

Base64 of:

```json
{ "x402Version": 1, "scheme": "exact", "network": "base",
  "payload": { "signature": "0x<65 bytes>", "authorization": { ... } } }
```

in the `X-PAYMENT` header. Echo the network back exactly as the server named
it. The facilitator settles the USDC and the resource returns 200.
