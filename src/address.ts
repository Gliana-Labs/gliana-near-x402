/**
 * Print the Base address a NEAR account controls, and stop.
 *
 * No gas, no RPC, no key — derivation is pure maths on the MPC root key. Run
 * this before funding anything: it is how you learn where to send the USDC.
 */
import { deriveEvmAddress, type NearNetwork } from './x402-payer.js';

const accountId = process.argv[2];
const path = process.argv[3] ?? 'gliana-x402';
const network = (process.argv[4] ?? 'mainnet') as NearNetwork;

if (!accountId) {
  console.error('usage: npm run address -- <account.near> [path] [mainnet|testnet]');
  process.exit(1);
}

const address = await deriveEvmAddress(accountId, path, network);
console.log(`NEAR account : ${accountId}`);
console.log(`path         : ${path}`);
console.log(`network      : ${network}`);
console.log(`Base address : ${address}`);
console.log('');
console.log('Send USDC on Base to that address to fund this agent.');
console.log('Nobody holds its private key — signing is a threshold of NEAR validators.');
