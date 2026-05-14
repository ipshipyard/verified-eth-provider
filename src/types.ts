export interface QuorumTrustedBlockSelectorConfig {
  primaryRpc: string
  witnessRpcs: [string, string]
  maxSafeBlockAgeMs: number
}

export interface QuorumTrustedBlockSelectorOptions {
  log?: (...args: any[]) => void
}

export interface VerifiedTransportConfig {
  rpcUrl: string
  trustedBlock: TrustedBlock | TrustedBlockProvider
}

export interface VerifiedTransportOptions {
  log?: (...args: any[]) => void
}

export interface TrustedBlock {
  number: string
  hash: string
  timestamp: string
  stateRoot: string
  baseFeePerGas?: string
  /** Block gas limit (EVM: GASLIMIT opcode). Equal to `block.gasLimit` in JSON-RPC. */
  gasLimit: string
  /** Block proposer address (EVM: COINBASE opcode). Equal to `block.miner` in JSON-RPC. */
  miner: string
  /** Beacon chain RANDAO mix at this block (EVM: PREVRANDAO opcode). Equal to `block.mixHash` in JSON-RPC. */
  mixHash: string
}

export type TrustedBlockProvider = (signal?: AbortSignal) => Promise<TrustedBlock>

export interface VerifiedTransport {
  (...args: Parameters<import('viem').Transport>): ReturnType<import('viem').Transport>
  prewarmVerificationDependencies: () => Promise<void>
  trustedBlock: TrustedBlock
}
