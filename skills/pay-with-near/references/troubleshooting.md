# What each failure actually means

Every row here was hit for real while building this.

## `invalid signature: not for a valid curve point`

The payload was parsed, the scheme and network matched, and the facilitator
got as far as recovering the key — so everything except the signature itself
is correct. Either the signature is fake, or `r`/`s` were assembled wrong.
Check that the compressed-point prefix was dropped from `big_r.affine_point`.

## The payment verifies but settles from the wrong address

Three causes, in order of likelihood:

1. **The EIP-712 domain disagrees with the token contract.** Use the `extra`
   from the challenge, never a hardcoded `{name, version}`.
2. **`v` is off by 27.** `recovery_id` is 0/1; EIP-3009 wants 27/28.
3. **The path changed.** A different path is a different address.

## `Please set a signer` / `Unknown provider type`

`@near-js/accounts` 2.5.1 takes `(accountId, provider, signer)` and wants
`KeyPairSigner`. The older `Connection.fromConfig` path throws these.

## The faucet returned HTTP 200 but the account does not exist

**NEAR reports `final_execution_status: "EXECUTED"` for a transaction that
FAILED.** Read `status`, not the execution status:

```json
{"Failure": {"ActionError": {"kind": {"OnlyImplicitAccountCreationAllowed": …}}}}
```

An implicit account (64 hex characters) is created by a **plain transfer** to
it, never by a `CreateAccount` action. For a named `*.testnet` account, the
helper's create does work.

## The sign call hangs

It takes about 15 seconds. That is normal — it is a threshold signature across
17 nodes, not a local operation. If it exceeds ~60s, check that 300 TGas was
attached; too little fails late with an out-of-gas that reads like a network
problem.

## `No option this payer can sign`

The resource offered only Solana, or only a non-`exact` scheme. Chain
Signatures produces an EIP-712 ECDSA signature, so an EVM `exact` option is
required. The error lists what was actually offered.

## The call was charged but returned an error

Do **not** retry automatically. The nonce is single-use, so a retry needs a
fresh authorization, and if the first one settled you have paid twice for one
answer. `payWithNear` returns the digest; reconcile against it first.
