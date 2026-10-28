# Pay for AI with a NEAR account — no EVM private key anywhere

**NEAR HACKATHON 2026 · track: Agent Economy (`agents`)**

An AI agent that holds a NEAR account buys paid HTTP APIs on Base — here, AI
inference on [GlianaAI](https://ai.glianalabs.com) — over the x402 payment
protocol. **The Base private key that pays does not exist**: NEAR Chain
Signatures signs the payment, and the key for that Base address is a threshold
of NEAR validators instead of a file on a disk.

## The problem

An agent that spends money has to hold a key, and a key is exactly the thing
you cannot hand to an agent, a container, or a hosted service. NEAR's own MCP
server (`nearai/near-mcp`) is local-only for that reason. Every paid API an
agent uses on another chain means another private key to keep somewhere.

## How it works

NEAR's Chain Signatures MPC (`v1.signer`: 17 nodes, threshold 11) signs an
arbitrary 32-byte hash on secp256k1. An EIP-3009 `transferWithAuthorization` —
how USDC moves on Base without gas — is an ECDSA signature over an EIP-712
digest. They are the same object, so a NEAR account can authorise a USDC
transfer on a chain it holds no key for.

```
1. derive address   offline, free     accountId + path -> Base address
2. POST the API                       -> 402: price, payTo, asset
3. build + hash     offline           EIP-3009 TransferWithAuthorization -> 32-byte digest
4. v1.signer.sign   ~15 s, NEAR gas   -> {r, s, v}
5. POST + X-PAYMENT                   -> 200: USDC moved, answer returned
```

**The seller changed nothing.** GlianaAI already issues and settles Base x402
challenges and does not care what produced the signature. Chain Signatures
makes a NEAR account a first-class buyer on another chain without asking any
seller to integrate anything.

## Try it — do X, see Y

Needs Node.js 20+. Steps 1-3 need no account, no key and no money.

1. **Install and run the tests.**
   ```bash
   npm install && npm test
   ```
   See: `34 passed`. They include a real reply from `v1.signer-prod.testnet`
   (a committed fixture) whose signature recovers to the address derived
   offline, and address derivation checked against `chainsig.js` vectors.

2. **Derive the Base address a NEAR account controls (offline).**
   ```bash
   npm run address -- gliana-x402.testnet gliana-x402 testnet
   ```
   See: `Base address : 0x951Ad1032C9ee0b4e4AcA5b96341033b7f3A3730` — the same
   address the real MPC signature in step 1 recovers to. Any account works, e.g.
   `npm run address -- example.near` → `0xd70820102138280884CDe32d8774746Abf34F09C`.

3. **See the price the seller asks (no payment).**
   ```bash
   curl -si -X POST https://api.glianalabs.com/x402/tools/token-price \
     -H 'content-type: application/json' -d '{"symbols":"NEAR,SOL","vs":"usd"}' | head -1
   ```
   See: `HTTP/2 402`. The `payment-required` header (base64 JSON) asks for
   `exact` on `eip155:8453` (Base), amount `2000` (= $0.002 USDC).

4. **Pay it with a NEAR account (real money: ~$0.002 plus NEAR gas).**
   Send a little USDC on Base to the address step 2 prints for *your* mainnet
   account, then:
   ```bash
   NEAR_KEY_FILE=~/.near-gliana/key.json npm run demo
   ```
   A key file is `{"account_id":"you.near","private_key":"ed25519:..."}`; keep
   it outside the repo. See: `Asking NEAR's MPC network to sign (this takes
   ~15s…)`, then `PAID 2000 microUSD on eip155:8453` and the token prices as JSON.

## What's here

```
src/x402-payer.ts        challenge -> EIP-712 digest -> X-PAYMENT header. Pure; no key.
src/signer.ts            the only part that costs gas: v1.signer via @near-js.
src/demo.ts              the five steps, end to end.
src/address.ts           print the Base address a NEAR account controls.
src/x402-payer.test.ts   derivation vectors, the real MPC fixture, payment construction.
skills/pay-with-near/    an agent skill in the near/agent-skills format.
demo/                    the recording script and the demo post.
```

## NEAR technology used

- **Chain Signatures** (`v1.signer` on mainnet, `v1.signer-prod.testnet`):
  signs the EIP-3009 digest; the Base address is derived from the MPC root key.
- **`@near-js/*`** for the signing transaction. Address derivation is
  implemented with `@noble` alone and matches `chainsig.js` on its vectors.

## Verified, not asserted

- **The MPC signature recovers to the address derived offline**
  (`0x951Ad1032C9ee0b4e4AcA5b96341033b7f3A3730`), from a real
  `v1.signer-prod.testnet` reply committed as a fixture: if either half
  drifts, the build breaks instead of money going to an address nobody controls.
- **Payment construction checked against the live facilitator:** a payment
  correct in every field but with a deliberately fake signature is rejected
  with `invalid signature: not for a valid curve point`, i.e. only the
  signature is wrong.
- **Measured: ~15 s per MPC signature.** Comfortable inside a 900 s x402
  window, not interactive. Said plainly because a demo that hides it is lying.

## Honest limits

- **Base (EVM) only.** Solana's `exact` scheme signs a serialized transaction,
  not an EIP-712 digest: possible with the same primitive, but a different
  construction, so it is refused with a reason rather than half-shipped.
- **15 seconds is slow.** It buys a key that does not exist.
- **One attempt, never an automatic retry.** The nonce is single-use, and a
  retry after a payment that did settle pays twice for one answer.

## Disclosure (hackathon rules Q-001, Q-002, Q-005)

- **Built for NEAR HACKATHON**, inside the window (it opened with the
  announcement on 2026-10-19; first commit 2026-10-20). Everything in this
  repository is hackathon work.
- **The seller, GlianaAI, is our existing product** (pay-per-call AI) and is
  not part of the submission; it was not changed for this. Only this client —
  paying with a NEAR account — is the entry.
- **Libraries:** `@near-js/*`, `@noble/curves`, `@noble/hashes`, `@scure/base`,
  `viem`. Written with AI assistance (Claude Code).

MIT — see [LICENSE](LICENSE).
