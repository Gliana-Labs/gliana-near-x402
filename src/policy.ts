/**
 * Pay through the agent-allowance contract (contract/src/lib.rs) instead of
 * asking v1.signer directly.
 *
 * The agent's NEAR key can only call the contract's `pay`. The contract holds
 * the Base address (derived from ITS account id), rebuilds the EIP-3009 digest
 * from the terms sent here, checks them against the owner's policy — payee
 * list, per-payment cap, daily budget, one-hour validity — and only then asks
 * the MPC to sign. A leaked agent key is worth at most one day's budget, paid
 * only to sellers the owner listed.
 *
 * Before sending, the contract's own digest is read back (`preview_digest`) and
 * must equal the one built here: a domain or encoding mismatch fails before any
 * gas is spent, instead of producing a signature for a different payment.
 *
 * Then the policy itself is asked as a free view (`check`, 2026-10-29): a refusal
 * learned from `pay` cost a transaction and 11.6 s on mainnet; from the view it
 * is ~0.3 s and nothing is sent. `pay` still enforces every rule on chain.
 */
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import type { Authorization, HashSigner, MpcSignature, NearNetwork } from './x402-payer.js';
import { rpcUrl, rsvFromMpc } from './x402-payer.js';

export interface PolicySignerOpts {
  /** The agent's own account: the only one the contract lets call `pay`. */
  accountId: string;
  privateKey: string;
  /** The agent-allowance contract that holds the Base address. */
  contractId: string;
  network?: NearNetwork;
  rpcUrl?: string;
  onWait?: (msg: string) => void;
}

const termsOf = (a: Authorization) => ({
  to: a.to,
  value: String(a.value),
  valid_after: String(a.validAfter),
  valid_before: String(a.validBefore),
  nonce: a.nonce,
});

export function policySigner(opts: PolicySignerOpts): HashSigner {
  const network = opts.network ?? 'mainnet';
  const provider = new JsonRpcProvider({ url: opts.rpcUrl ?? rpcUrl(network) });
  const account = new Account(opts.accountId, provider, new KeyPairSigner(KeyPair.fromString(opts.privateKey as `ed25519:${string}`)));

  return async (digest, auth) => {
    const theirs = await provider.callFunction(opts.contractId, 'preview_digest', termsOf(auth));
    if (String(theirs).toLowerCase() !== digest.toLowerCase()) {
      throw new Error(`The allowance contract builds a different digest (${String(theirs)}) than this client (${digest}); not signing.`);
    }
    const why = (await provider.callFunction(opts.contractId, 'check', { agent: opts.accountId, to: auth.to, value: String(auth.value), valid_after: String(auth.validAfter), valid_before: String(auth.validBefore) })) as string | null;
    if (why) throw new Error(`Smart contract panicked: ${why}`);
    opts.onWait?.(`Asking the allowance contract ${opts.contractId} to approve and NEAR's MPC network to sign (~15s)…`);
    const result = (await account.callFunction({
      contractId: opts.contractId,
      methodName: 'pay',
      args: termsOf(auth),
      gas: 300_000_000_000_000n,
      deposit: 1n,
    })) as unknown as MpcSignature | null;
    if (!result?.big_r?.affine_point || !result?.s?.scalar) {
      throw new Error('The MPC returned no signature (the budget was given back). Try again.');
    }
    return rsvFromMpc(result);
  };
}
