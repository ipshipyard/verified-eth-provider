import { custom } from 'viem'
import { createSingleRpcVerifier } from './provider.ts'
import { validateTrustedBlock } from './helpers.ts'
import type {
  TrustedBlock,
  VerifiedTransport,
  VerifiedTransportConfig,
  VerifiedTransportOptions
} from './types.ts'

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
      return verifier.requestPinned<unknown>(method, params ?? [], trustedBlock)
    }
  }) as VerifiedTransport

  transport.prewarmVerificationDependencies = async () => {
    await verifier.prewarmVerificationDependencies()
  }

  transport.trustedBlock = trustedBlock

  return transport
}
