# Pay for AI with a NEAR account — no EVM private key anywhere

**NEAR HACKATHON 2026 · tracks: Agent Economy (`agents`), AI Security & Defense (`security`)**

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
   account. The NEAR account must hold **at least ~0.35 NEAR** when it signs:
   NEAR reserves the call's 300 TGas at a pessimistic gas price (~0.30 NEAR)
   and refunds what is unused, so ~0.03 NEAR is actually spent. Then:
   ```bash
   NEAR_KEY_FILE=~/.near-gliana/key.json npm run demo
   ```
   A key file is `{"account_id":"you.near","private_key":"ed25519:..."}`; keep
   it outside the repo. See: `Asking NEAR's MPC network to sign (this takes
   ~15s…)`, then `PAID 2000 microUSD on eip155:8453` and the token prices as JSON.

## The safety layer: an allowance enforced on NEAR

Holding no Base key is half the story. The agent still holds a NEAR key, and a
leaked NEAR key could sign anything. So the agent's key does not sign payments
at all: it can only **ask** a contract.

`contract/` is `agent-allowance`, a NEAR contract that **holds the agent's Base
address** — derived from the contract's own account id, so only the contract
can get a payment from it signed. The agent sends the payment's terms; the
contract rebuilds the EIP-3009 digest itself (the agent cannot slip a different
payment past it), checks the owner's policy, and only then calls `v1.signer`:

| Check | Default |
| --- | --- |
| Payee is on the owner's list | GlianaAI's Base `payTo` |
| Amount per payment | at most $0.01 |
| Total per day | at most $0.05 (given back if signing fails) |
| Authorization lifetime | at most 1 hour, so no long-lived signature exists |

A leaked agent key is worth at most one day's budget, paid only to sellers the
owner chose. The owner can pause it, swap the agent account (`set_agent`),
change limits and payees, and move funds without the limits (`owner_pay`).

**Verified on live testnet** (`allowance.gliana-x402.testnet`, signer
`v1.signer-prod.testnet`): a $0.002 payment to the listed payee was approved and
signed in 19 s, and the signature recovers to exactly the contract's Base
address `0xe32847B59D97cF36915D92064B99543743A88493`; the same call to an
unlisted payee was refused on chain with `payee is not on the owner's list`.

Try it — do X, see Y:

5. **Run the contract's tests** (Rust 1.95 is pinned in `contract/rust-toolchain.toml`).
   ```bash
   npm run contract:test
   ```
   See: `10 passed` — including the contract's digest matching viem's byte for byte
   (USDC's real Base domain separator `0x02fa7265…834f`), the payee list, both caps,
   the day roll-over, the refund on a failed signature, and pausing.

6. **Deploy your own allowance on testnet** (free; needs a testnet account key file).
   ```bash
   npm run contract:build
   NEAR_KEY_FILE=~/.near-gliana/you.testnet.json NEAR_NETWORK=testnet npm run allowance:deploy
   ```
   See: `allowance.<you>` and `agent.<you>` created (keys saved owner-only in
   `~/.near-gliana/`), the contract initialised, and its policy and Base address printed.

7. **Pay through it.**
   ```bash
   AGENT_KEY_FILE=~/.near-gliana/agent.<you>.json ALLOWANCE=allowance.<you> NEAR_NETWORK=testnet npm run allowance:pay
   ```
   See: the contract approve and the MPC sign (~15-20 s). With USDC at the printed
   Base address the payment settles; a payee off the list is refused with the
   contract's own reason.

For production, delete the contract account's full-access key after deploying
(`near account delete-keys`), so nobody — not even the owner's machine — can
redeploy it past the policy; the owner keeps control through `set_*` and `owner_pay`.

## Use it from any AI agent (MCP)

The same payer ships in [`gliana-ai-mcp`](https://www.npmjs.com/package/gliana-ai-mcp)
(0.10+), the MCP server for Claude, Cursor and any MCP client — so an agent pays
for 100+ AI models and 60+ tools with a NEAR account and no code:

```json
{
  "mcpServers": {
    "gliana-ai": {
      "command": "npx",
      "args": ["-y", "gliana-ai-mcp"],
      "env": {
        "GLIANA_NEAR_KEY_FILE": "/home/you/.near-gliana/agent.you.near.json",
        "GLIANA_NEAR_ALLOWANCE": "allowance.you.near"
      }
    }
  }
}
```

With `GLIANA_NEAR_ALLOWANCE` the key is the agent's and only asks the contract;
without it, the NEAR account signs directly. The `wallet` tool shows the Base
address to fund; a policy refusal comes back as the contract's own reason.
Verified end to end on testnet (MCP → contract approves → MPC signs → x402).

## What's here

```
src/x402-payer.ts        challenge -> EIP-712 digest -> X-PAYMENT header. Pure; no key.
src/signer.ts            the only part that costs gas: v1.signer via @near-js.
src/demo.ts              the five steps, end to end.
src/address.ts           print the Base address a NEAR account controls.
src/policy.ts            pay through the allowance contract (checks its digest matches first).
src/deploy-allowance.ts  create allowance.<you> + agent.<you>, deploy, set the policy.
src/policy-demo.ts       the agent pays through the allowance.
contract/                agent-allowance: the NEAR contract (Rust, near-sdk), with its tests.
src/x402-payer.test.ts   derivation vectors, the real MPC fixture, payment construction.
skills/pay-with-near/    an agent skill in the near/agent-skills format.
demo/                    the recording script and the demo post.
```

## NEAR technology used

- **Chain Signatures** (`v1.signer` on mainnet, `v1.signer-prod.testnet`):
  signs the EIP-3009 digest; the Base address is derived from the MPC root key.
- **A NEAR smart contract** (`contract/`, Rust near-sdk) that owns the Base address and enforces the budget, calling `v1.signer` cross-contract.
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
