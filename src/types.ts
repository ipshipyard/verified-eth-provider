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
}

export type TrustedBlockProvider = (signal?: AbortSignal) => Promise<TrustedBlock>

export interface VerifiedTransport {
  (...args: Parameters<import('viem').Transport>): ReturnType<import('viem').Transport>
  prewarmVerificationDependencies: () => Promise<void>
  trustedBlock: TrustedBlock
}
