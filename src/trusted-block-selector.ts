import { assertBlockFreshness } from './helpers.ts'
import type {
  QuorumTrustedBlockSelectorConfig,
  QuorumTrustedBlockSelectorOptions,
  TrustedBlock,
  TrustedBlockProvider
} from './types.ts'

interface JsonRpcResponse<T> {
  result: T
  error?: { code: number, message: string }
}

const MAINNET_CHAIN_ID_HEX = '0x1'

async function ethCall<T> (url: string, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal
  })

  if (!response.ok) {
    throw new Error(`RPC ${url} returned HTTP ${response.status} for ${method}`)
  }

  const body: JsonRpcResponse<T> = await response.json()

  if (body.error != null) {
    throw new Error(`RPC ${url} error for ${method}: ${body.error.message}`)
  }

  return body.result
}

async function getChainId (rpcUrl: string, signal?: AbortSignal): Promise<string> {
  return ethCall<string>(rpcUrl, 'eth_chainId', [], signal)
}

async function assertMainnet (rpcUrl: string, signal?: AbortSignal): Promise<void> {
  const chainId = await getChainId(rpcUrl, signal)

  if (chainId.toLowerCase() !== MAINNET_CHAIN_ID_HEX) {
    throw new Error(`RPC ${rpcUrl} is not mainnet (chainId=${chainId})`)
  }
}

async function getBlockByNumber (rpcUrl: string, blockNumber: string, signal?: AbortSignal): Promise<TrustedBlock> {
  const block = await ethCall<TrustedBlock | null>(rpcUrl, 'eth_getBlockByNumber', [blockNumber, false], signal)

  if (block == null) {
    throw new Error(`RPC ${rpcUrl} returned null block for ${blockNumber}`)
  }

  return block
}

async function confirmBlockHashWithWitnesses (block: TrustedBlock, witnessRpcs: [string, string], signal?: AbortSignal): Promise<void> {
  const [witnessA, witnessB] = await Promise.all([
    getBlockByNumber(witnessRpcs[0], block.number, signal),
    getBlockByNumber(witnessRpcs[1], block.number, signal)
  ])

  if (witnessA.hash.toLowerCase() !== block.hash.toLowerCase()) {
    throw new Error(`Witness A (${witnessRpcs[0]}) block hash ${witnessA.hash} does not match primary ${block.hash} at block ${block.number}`)
  }

  if (witnessB.hash.toLowerCase() !== block.hash.toLowerCase()) {
    throw new Error(`Witness B (${witnessRpcs[1]}) block hash ${witnessB.hash} does not match primary ${block.hash} at block ${block.number}`)
  }
}

export function createQuorumTrustedBlockSelector (config: QuorumTrustedBlockSelectorConfig, options: QuorumTrustedBlockSelectorOptions = {}): TrustedBlockProvider {
  return async (signal?: AbortSignal): Promise<TrustedBlock> => {
    const { primaryRpc, witnessRpcs, maxSafeBlockAgeMs } = config

    await Promise.all([
      assertMainnet(primaryRpc, signal),
      assertMainnet(witnessRpcs[0], signal),
      assertMainnet(witnessRpcs[1], signal)
    ])

    const safeBlock = await getBlockByNumber(primaryRpc, 'safe', signal)
    await confirmBlockHashWithWitnesses(safeBlock, witnessRpcs, signal)
    assertBlockFreshness(safeBlock, maxSafeBlockAgeMs)

    options.log?.('safe block from primary: %s hash=%s', safeBlock.number, safeBlock.hash)
    return safeBlock
  }
}
