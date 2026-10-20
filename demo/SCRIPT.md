# Demo script

90 seconds. The 15-second MPC wait is the problem to solve and the point to
make — it is dead air only if you have nothing to say during it, and you do.

**Record the terminal, do not stream it.** One take, no cuts inside the wait.
Cutting the wait out is the one thing that makes this look fake.

---

## Shot 1 — the claim (0:00–0:12)

Terminal, nothing running.

> "This agent is about to buy an AI inference call on Base. It has no Base
> private key. Not stored somewhere safe — it does not exist."

## Shot 2 — the address (0:12–0:28)

```bash
npm run address -- gliana-x402.near
```

Prints instantly.

> "That Base address comes from the NEAR account plus a path. Pure maths on
> the MPC's root key — no network call, no gas, no account needed. Anyone can
> compute it. Nobody can spend from it."

## Shot 3 — the 402 (0:28–0:40)

```bash
NEAR_KEY_FILE=key.json npm run demo
```

The probe returns the challenge.

> "GlianaAI answers 402 with a price. Two thousand micro-dollars. Point two
> cents."

## Shot 4 — THE WAIT (0:40–0:58)

This is the shot. 15 seconds of a single log line. Fill it:

> "Now NEAR's MPC network signs. Seventeen nodes, eleven have to agree. That
> is why this takes fifteen seconds instead of one millisecond — and it is
> also the whole point. A local key signs instantly because one machine holds
> it. This is slow because no machine holds it."

Then, if there is still time:

> "What it is signing is an EIP-3009 transfer authorisation. Which is just an
> ECDSA signature over a hash. Which is exactly what this network already
> does."

## Shot 5 — paid (0:58–1:12)

```
PAID 2000 microUSD on base
```

plus the model's answer.

> "Settled on Base. The agent paid from a NEAR account, and the seller
> changed nothing — it already speaks x402 and does not care what produced
> the signature."

## Shot 6 — the close (1:12–1:30)

> "NEAR's own MCP server is local-only. The repo says why: it handles private
> keys, so there is no hosted version. That is the ceiling on every agent
> that spends money. Chain Signatures removes it."

---

## Rules

- **Do not cut the wait.** Narrate it. Hiding it invites the question in
  judging; owning it answers it first.
- **Do not fake the output.** Run it against mainnet with real USDC.
- **Say the price out loud.** $0.002 is more persuasive than any adjective.
- Have the block explorer ready but do not film it — link it in the X post.

## Pre-flight

```
[ ] mainnet NEAR account funded (a few NEAR; sign is 300 TGas + 1 yocto)
[ ] the derived Base address funded with USDC (a dollar is plenty)
[ ] npm run address -- <account>   prints the address you funded
[ ] one full dry run, end to end, before recording
[ ] terminal font large enough to read on a phone
```
