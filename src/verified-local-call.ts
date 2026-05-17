import { Common, Mainnet } from '@ethereumjs/common'
import { createEVM } from '@ethereumjs/evm'
import { fromMerkleStateProof } from '@ethereumjs/statemanager'
import { bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util'
import type { VerifiedStateBundle } from './provider.js'
import type { TrustedBlock } from './types.js'

interface VerifiedLocalCallArgs {
  from: string
  to: string
  state: VerifiedStateBundle
  data: `0x${string}`
  value: bigint
  callGasLimit: bigint
  block: TrustedBlock
}

export class LocalCallExecutionError extends Error {
  code: number
  data?: `0x${string}`
  reason: 'revert' | 'out-of-gas' | 'other'

  constructor (message: string, reason: 'revert' | 'out-of-gas' | 'other', data?: `0x${string}`) {
    super(message)
    this.name = 'LocalCallExecutionError'
    this.code = 3
    this.data = data
    this.reason = reason
  }
}

export async function executeVerifiedLocalCall (args: VerifiedLocalCallArgs): Promise<`0x${string}`> {
  const blockTimestamp = BigInt(args.block.timestamp)

  const common = new Common({ chain: Mainnet })
  // Post-merge hardfork selection is timestamp-based. Using blockNumber alone incorrectly
  // selects paris for all post-merge blocks. Both must be provided.
  common.setHardforkBy({ blockNumber: BigInt(args.block.number), timestamp: blockTimestamp })

  if (!common.gteHardfork('paris')) {
    throw new Error(
      `Block ${args.block.number} predates The Merge (Paris hardfork). Pre-merge blocks are not supported.`
    )
  }

  const stateManager = await fromMerkleStateProof(args.state.proofs, true, {
    common
  })

  for (const [address, code] of Object.entries(args.state.codeByAddress)) {
    await stateManager.putCode(createAddressFromString(address), hexToBytes(code))
  }

  const from = createAddressFromString(args.from)
  const to = createAddressFromString(args.to)

  const evm = await createEVM({
    common,
    stateManager
  })

  const result = await evm.runCall({
    block: {
      header: {
        // Verified fields from the quorum-agreed TrustedBlock:
        number: BigInt(args.block.number),
        timestamp: blockTimestamp,
        // undefined → EVM throws 'Block has no Base Fee' (correct: surfaces as error,
        // not a silent wrong value). In practice always present for post-London blocks.
        baseFeePerGas: args.block.baseFeePerGas != null ? BigInt(args.block.baseFeePerGas) : undefined,

        // Correct by definition post-merge (EIP-3675): difficulty is always 0.
        difficulty: 0n,

        // Verified fields from TrustedBlock: block proposer and beacon chain RANDAO mix.
        coinbase: createAddressFromString(args.block.miner),
        prevRandao: hexToBytes(args.block.mixHash as `0x${string}`),

        // Verified field from TrustedBlock.
        gasLimit: BigInt(args.block.gasLimit),

        // Blob base fee is not yet part of TrustedBlock. Returning undefined causes the EVM to throw
        // 'Block has no Blob Base Fee' if a contract executes BLOBBASEFEE. This is
        // preferable to silently returning 0.
        getBlobGasPrice: () => undefined
      }
    },
    caller: from,
    origin: from,
    to,
    data: hexToBytes(args.data),
    gasLimit: args.callGasLimit,
    value: args.value,
    // Read-only zero-value call: skip the caller's balance check. The verified request path
    // rejects non-zero value before execution.
    skipBalance: true
  })

  if (result.execResult.exceptionError != null) {
    const evmError = result.execResult.exceptionError.error
    let reason: 'revert' | 'out-of-gas' | 'other' = 'other'
    if (evmError === 'revert') {
      reason = 'revert'
    } else if (evmError === 'out of gas' || evmError === 'code store out of gas') {
      reason = 'out-of-gas'
    }

    const revertData = result.execResult.returnValue.length > 0
      ? bytesToHex(result.execResult.returnValue)
      : undefined

    throw new LocalCallExecutionError(
      `execution reverted: ${result.execResult.exceptionError.error}`,
      reason,
      revertData
    )
  }

  return bytesToHex(result.execResult.returnValue)
}
