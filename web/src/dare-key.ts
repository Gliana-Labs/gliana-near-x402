// Published on purpose (src/make-dare-key.ts): a testnet key that can only ask the testnet allowance contract for a payment.
// It holds no money and can't move any. Nothing here works on mainnet.
export const DARE = { network: 'testnet', account: 'agent.gliana-x402.testnet', contract: 'allowance.gliana-x402.testnet', key: 'ed25519:3oVSaz9QP99U6bHskTmPcdgz4j66LQV7KRGP5Fdo5jz6jpKqRjcXwPn9yMzs7N6irR7ig9EShSPfcb1YVPuv1GLv' } as const;
