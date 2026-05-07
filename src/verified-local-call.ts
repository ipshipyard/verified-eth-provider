import { Common, Hardfork, Mainnet } from '@ethereumjs/common'
import { createEVM } from '@ethereumjs/evm'
import { fromMerkleStateProof } from '@ethereumjs/statemanager'
import { bytesToHex, createAddressFromString, createZeroAddress, hexToBytes } from '@ethereumjs/util'

interface Eip1186StorageProof {
  key: string
  value: string
  proof: string[]
}

interface Eip1186Proof {
  address: string
  balance: string
  codeHash: string
  nonce: string
  accountProof: string[]
  storageHash: string
  storageProof: Eip1186StorageProof[]
}

export interface VerifiedStateBundle {
  proofs: Eip1186Proof[]
  codeByAddress: Record<string, `0x${string}`>
}

interface VerifiedLocalCallArgs {
  to: string
  state: VerifiedStateBundle
  data: `0x${string}`
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

const common = new Common({
  chain: Mainnet,
  hardfork: Hardfork.Cancun
})

export async function executeVerifiedLocalCall (args: VerifiedLocalCallArgs): Promise<`0x${string}`> {
  const stateManager = await fromMerkleStateProof(args.state.proofs as any, true, {
    common
  })

  for (const [address, code] of Object.entries(args.state.codeByAddress)) {
    await stateManager.putCode(createAddressFromString(address), hexToBytes(code))
  }

  const to = createAddressFromString(args.to)

  const evm = await createEVM({
    common,
    stateManager
  })

  const result = await evm.runCall({
    caller: createZeroAddress(),
    origin: createZeroAddress(),
    to,
    data: hexToBytes(args.data),
    gasLimit: 30_000_000n,
    value: 0n,
    skipBalance: true
  })

  if (result.execResult.exceptionError != null) {
    const evmError = result.execResult.exceptionError.error
    const reason: 'revert' | 'out-of-gas' | 'other' = 
      evmError === 'revert' ? 'revert' : 
      evmError === 'out of gas' || evmError === 'code store out of gas' ? 'out-of-gas' :
      'other'
    
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