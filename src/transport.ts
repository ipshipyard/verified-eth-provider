import { custom } from 'viem'
import { createSingleRpcVerifier } from './provider.js'
import { validateTrustedBlock } from './helpers.js'
import type {
  TrustedBlock,
  VerifiedTransport,
  VerifiedTransportConfig,
  VerifiedTransportOptions
} from './types.js'

export async function createVerifiedTransport (
  config: VerifiedTransportConfig,
  options: VerifiedTransportOptions = {}
): Promise<VerifiedTransport> {
  const verifier = createSingleRpcVerifier({ rpcUrl: config.rpcUrl }, options)
  const trustedBlock = validateTrustedBlock(
    typeof config.trustedBlock === 'function'
      ? await config.trustedBlock()
      : config.trustedBlock
  )

  const transport = custom({
    request: async ({ method, params }: { method: string, params?: unknown[] }) => {
      // The second parameter of eth_call and eth_getCode is the block tag. Some
      // callers (e.g. viem defaults to "latest", post-merge code may use "safe" or
      // "finalized") do not explicitly pin a block number. Since this transport is
      // bound to a single trusted block, map any non-specific tag ("latest",
      // "safe", "finalized", or absent) to that block's number so that all
      // verification is consistent.
      const normalizedParams = (params ?? []).map((p, i) =>
        i === 1 && (p === 'latest' || p === 'safe' || p === 'finalized' || p === undefined) ? trustedBlock.number : p
      )
      return verifier.requestPinned<unknown>(method, normalizedParams, trustedBlock)
    }
  }) as VerifiedTransport

  transport.prewarmVerificationDependencies = async () => {
    await verifier.prewarmVerificationDependencies()
  }

  transport.trustedBlock = trustedBlock

  return transport
}
