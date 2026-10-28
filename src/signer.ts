/**
 * The one piece that costs gas: asking NEAR's MPC to sign a digest.
 *
 * Everything else in this repo is pure. This file turns a NEAR account into a
 * `HashSigner`, which is the only thing `payWithNear` needs in order to pay a
 * 402 on Base — and the private key for that Base address does not exist. It
 * is a threshold of 11 out of 17 NEAR validators.
 */
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import {
  rsvFromMpc,
  signArgs,
  SIGN_GAS,
  SIGN_DEPOSIT,
  SIGNER_CONTRACT,
  type HashSigner,
  type MpcSignature,
  type NearNetwork,
  rpcUrl,
} from './x402-payer.js';

export interface NearSignerOpts {
  accountId: string;
  /** ed25519:... — the account's full-access key. */
  privateKey: string;
  /** Any string. The SAME path always gives the SAME Base address. */
  path: string;
  network?: NearNetwork;
  rpcUrl?: string;
  /** Called before the ~15s wait, so a caller can say what it is doing. */
  onWait?: (msg: string) => void;
}

/**
 * A HashSigner backed by NEAR Chain Signatures.
 *
 * MEASURED: a sign call takes about 15 SECONDS. That is comfortable inside an
 * x402 authorization window (900s here) but far too slow to look interactive,
 * so `onWait` exists to let a caller explain the pause rather than appear
 * hung. Do not wrap this in a spinner with a 10s timeout.
 */
export function nearSigner(opts: NearSignerOpts): HashSigner {
  const network = opts.network ?? 'mainnet';
  const provider = new JsonRpcProvider({ url: opts.rpcUrl ?? rpcUrl(network) });
  const account = new Account(opts.accountId, provider, new KeyPairSigner(KeyPair.fromString(opts.privateKey as `ed25519:${string}`)));

  return async (digest) => {
    opts.onWait?.(`Asking NEAR's MPC network to sign (this takes ~15s; it is a threshold signature, not a local key)…`);
    const result = (await account.callFunction({
      contractId: SIGNER_CONTRACT[network],
      methodName: 'sign',
      args: signArgs(digest, opts.path),
      // 300 TGas is the per-call maximum. The MPC needs it; a smaller budget
      // fails late, after the wait, with an out-of-gas that looks like the
      // network being down.
      gas: SIGN_GAS,
      deposit: SIGN_DEPOSIT,
    })) as unknown as MpcSignature;

    if (!result?.big_r?.affine_point || !result?.s?.scalar) {
      throw new Error(`v1.signer returned no signature. Got: ${JSON.stringify(result).slice(0, 200)}`);
    }
    return rsvFromMpc(result);
  };
}
