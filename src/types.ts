export interface QuorumTrustedBlockSelectorConfig {
  primaryRpc: string
  witnessRpcs: [string, string]
  maxSafeBlockAgeMs: number
  /**
   * Block tag to fetch from the primary RPC. Defaults to `"safe"`.
   *
   * - `"safe"` — post-merge beacon chain checkpoint, confirmed by ≥2 epochs (~64 blocks).
   * - `"finalized"` — fully finalized beacon chain block; more conservative than `"safe"`.
   * - `"latest"` — most recent block; fastest, but offers the least reorg protection.
   */
  blockTag?: 'latest' | 'safe' | 'finalized'
}

export interface QuorumTrustedBlockSelectorOptions {
  log? (...args: any[]): void
}

export interface VerifiedTransportConfig {
  rpcUrl: string
  trustedBlock: TrustedBlock | TrustedBlockProvider
}

export interface VerifiedTransportOptions {
  log? (...args: any[]): void
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
  prewarmVerificationDependencies(): Promise<void>
  trustedBlock: TrustedBlock
}
