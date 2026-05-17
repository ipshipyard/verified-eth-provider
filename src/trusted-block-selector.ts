import { assertBlockFreshness, validateTrustedBlock } from './helpers.js'
import { ethCall } from './json-rpc.js'
import type {
  QuorumTrustedBlockSelectorConfig,
  QuorumTrustedBlockSelectorOptions,
  TrustedBlock,
  TrustedBlockProvider
} from './types.js'

function parseTrustedBlock (value: unknown, rpcUrl: string, blockRef: string): TrustedBlock {
  if (value == null || typeof value !== 'object') {
    throw new Error(`RPC ${rpcUrl} returned invalid block payload for ${blockRef}`)
  }

  // Cast to a record first, then let validateTrustedBlock validate and normalize
  // every field. Wrap any validation error with the RPC URL for context.
  const block = value as Record<string, unknown>
  try {
    // Return a canonical TrustedBlock shape only, intentionally discarding extra fields.
    return validateTrustedBlock({
      number: block.number as string,
      hash: block.hash as string,
      timestamp: block.timestamp as string,
      stateRoot: block.stateRoot as string,
      baseFeePerGas: block.baseFeePerGas != null ? block.baseFeePerGas as string : undefined,
      gasLimit: block.gasLimit as string,
      miner: block.miner as string,
      mixHash: block.mixHash as string
    })
  } catch (err) {
    throw new Error(`RPC ${rpcUrl} returned invalid block for ${blockRef}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assertMatchingTrustedBlock (label: string, rpcUrl: string, expected: TrustedBlock, actual: TrustedBlock): void {
  if (actual.number !== expected.number) {
    throw new Error(`${label} (${rpcUrl}) block number ${actual.number} does not match primary ${expected.number}`)
  }

  if (actual.hash !== expected.hash) {
    throw new Error(`${label} (${rpcUrl}) block hash ${actual.hash} does not match primary ${expected.hash} at block ${expected.number}`)
  }

  if (actual.timestamp !== expected.timestamp) {
    throw new Error(`${label} (${rpcUrl}) timestamp ${actual.timestamp} does not match primary ${expected.timestamp} at block ${expected.number}`)
  }

  if (actual.stateRoot !== expected.stateRoot) {
    throw new Error(`${label} (${rpcUrl}) stateRoot ${actual.stateRoot} does not match primary ${expected.stateRoot} at block ${expected.number}`)
  }

  if (actual.baseFeePerGas !== expected.baseFeePerGas) {
    throw new Error(`${label} (${rpcUrl}) baseFeePerGas ${String(actual.baseFeePerGas)} does not match primary ${String(expected.baseFeePerGas)} at block ${expected.number}`)
  }

  if (actual.gasLimit !== expected.gasLimit) {
    throw new Error(`${label} (${rpcUrl}) gasLimit ${actual.gasLimit} does not match primary ${expected.gasLimit} at block ${expected.number}`)
  }

  if (actual.miner !== expected.miner) {
    throw new Error(`${label} (${rpcUrl}) miner ${actual.miner} does not match primary ${expected.miner} at block ${expected.number}`)
  }

  if (actual.mixHash !== expected.mixHash) {
    throw new Error(`${label} (${rpcUrl}) mixHash ${actual.mixHash} does not match primary ${expected.mixHash} at block ${expected.number}`)
  }
}

async function getBlockByNumber (rpcUrl: string, blockNumber: string, signal?: AbortSignal): Promise<TrustedBlock> {
  const block = await ethCall<unknown>(rpcUrl, 'eth_getBlockByNumber', [blockNumber, false], signal)

  if (block == null) {
    throw new Error(`RPC ${rpcUrl} returned null block for ${blockNumber}`)
  }

  return parseTrustedBlock(block, rpcUrl, blockNumber)
}

async function confirmBlockWithWitnesses (block: TrustedBlock, witnessRpcs: [string, string], signal?: AbortSignal): Promise<void> {
  const [witnessA, witnessB] = await Promise.all([
    getBlockByNumber(witnessRpcs[0], block.number, signal),
    getBlockByNumber(witnessRpcs[1], block.number, signal)
  ])

  assertMatchingTrustedBlock('Witness A', witnessRpcs[0], block, witnessA)
  assertMatchingTrustedBlock('Witness B', witnessRpcs[1], block, witnessB)
}

/**
 * Creates a {@link TrustedBlockProvider} that selects a trusted block by quorum: the primary RPC
 * fetches the block at the configured `blockTag` (default: `"safe"`) and both witness RPCs must
 * independently confirm the same TrustedBlock fields
 * (number/hash/timestamp/stateRoot/baseFeePerGas/gasLimit/miner/mixHash) before it is trusted.
 *
 * All three RPC endpoints must point to Ethereum mainnet. No chain ID verification is performed —
 * quorum detects endpoint disagreement, not unanimous misconfiguration.
 */
export function createQuorumTrustedBlockSelector (config: QuorumTrustedBlockSelectorConfig, options: QuorumTrustedBlockSelectorOptions = {}): TrustedBlockProvider {
  return async (signal?: AbortSignal): Promise<TrustedBlock> => {
    const { primaryRpc, witnessRpcs, maxSafeBlockAgeMs, blockTag = 'safe' } = config

    const primaryBlock = await getBlockByNumber(primaryRpc, blockTag, signal)
    await confirmBlockWithWitnesses(primaryBlock, witnessRpcs, signal)
    assertBlockFreshness(primaryBlock, maxSafeBlockAgeMs)

    options.log?.('%s block from primary: %s hash=%s', blockTag, primaryBlock.number, primaryBlock.hash)
    return primaryBlock
  }
}
