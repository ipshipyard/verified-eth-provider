import {
  chunkArray,
  ensureHexAddress,
  ensureHexData,
  ensureHexQuantity,
  isRetryableLocalExecutionError,
  mergeAccessLists,
  runWithConcurrency
} from './helpers.js'
import { ethCall, ethBatchCall } from './json-rpc.js'
import { executeVerifiedLocalCall, LocalCallExecutionError } from './verified-local-call.js'
import type { AccessListResult } from './helpers.js'
import type { TrustedBlock } from './types.js'
import type { Proof } from '@ethereumjs/common'
import type { MerklePatriciaTrie, MPTOpts } from '@ethereumjs/mpt'

interface VerifiedAccountState {
  nonce: Uint8Array
  balance: Uint8Array
  storageRoot: Uint8Array
  codeHash: Uint8Array
}

interface SingleRpcVerifierConfig {
  rpcUrl: string
}

interface SingleRpcVerifierOptions {
  log? (...args: any[]): void
}

interface SingleRpcVerifier {
  requestPinned<T>(method: string, params: unknown[], safeBlock: TrustedBlock, signal?: AbortSignal): Promise<T>
  prewarmVerificationDependencies(): Promise<void>
}

interface JsonRpcTransactionCall {
  from?: string
  to?: string
  data?: string
  value?: string
  gas?: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
}

export interface VerifiedStateBundle {
  /**
   * EIP-1186 account proofs as returned by `eth_getProof`, with the following fields
   * cryptographically verified against the trusted state root before inclusion:
   * `address`, `accountProof`, `storageHash`, `codeHash`, `nonce`, `balance`.
   *
   * `storageProof[i].value` is NOT explicitly verified here and must not be read as a
   * trusted storage value. The EVM derives storage values from the proof trie nodes
   * (via `fromMerkleStateProof` with `safe=true`), never from this convenience field.
   */
  proofs: Proof[]
  codeByAddress: Record<string, `0x${string}`>
}

interface ProofTools {
  createMPTFromProof(proof: Uint8Array[], trieOpts?: MPTOpts): Promise<MerklePatriciaTrie>
  rlpDecode(input: Uint8Array): any
}

interface HexTools {
  hexToBytes(value: `0x${string}`): Uint8Array
  bytesToHex(value: Uint8Array): `0x${string}`
  keccak256(value: `0x${string}`): `0x${string}`
}

const MAX_VERIFIED_CALL_RETRIES = 3
const MAX_BATCH_SIZE = 8
const MAX_PARALLEL_ACCOUNT_BATCHES = 4
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// Default transaction gas limit used for local EVM execution when the caller does not
// supply one. This bounds execution steps for read-only calls; it is distinct from the
// verified block header gasLimit used by the GASLIMIT opcode.
const DEFAULT_CALL_GAS_LIMIT = '0x1c9c380' // 30,000,000

// Minimum EIP-1559 priority fee used when constructing the eth_createAccessList request.
// Some RPC nodes reject zero-fee transactions at the API layer even for access list probing.
// This floor exists purely to satisfy RPC validation — it has no effect on actual execution.
const MIN_PRIORITY_FEE_PER_GAS = 1_000_000_000n // 1 Gwei

let proofToolsCache: ProofTools | null = null
let hexToolsCache: HexTools | null = null

async function loadProofTools (): Promise<ProofTools> {
  if (proofToolsCache != null) {
    return proofToolsCache
  }

  const [
    { createMPTFromProof },
    { decode: rlpDecode }
  ] = await Promise.all([
    import('@ethereumjs/mpt'),
    import('@ethereumjs/rlp')
  ])

  const tools: ProofTools = {
    createMPTFromProof,
    rlpDecode
  }

  proofToolsCache = tools

  return tools
}

async function loadHexTools (): Promise<HexTools> {
  if (hexToolsCache != null) {
    return hexToolsCache
  }

  const { hexToBytes, bytesToHex, keccak256 } = await import('viem')

  const tools: HexTools = {
    hexToBytes,
    bytesToHex,
    keccak256
  }

  hexToolsCache = tools

  return tools
}

function assertParamCount (method: string, params: unknown[], expected: number): void {
  if (params.length !== expected) {
    throw new Error(`${method} expects exactly ${expected} parameter(s), got ${params.length}`)
  }
}

function assertSafeBlockNumberParam (method: string, blockParam: unknown, safeBlockNumber: string): void {
  if (typeof blockParam !== 'string' || blockParam.toLowerCase() !== safeBlockNumber.toLowerCase()) {
    throw new Error(`${method} block parameter must match trusted block ${safeBlockNumber}`)
  }
}

function decodeAccountState (accountRlpValue: Uint8Array, proofTools: ProofTools): VerifiedAccountState {
  const decoded = proofTools.rlpDecode(accountRlpValue)

  if (!Array.isArray(decoded) || decoded.length < 4) {
    throw new Error('Failed to decode account value from account proof')
  }

  const nonce = decoded[0]
  const balance = decoded[1]
  const storageRoot = decoded[2]
  const codeHash = decoded[3]

  if (
    !(nonce instanceof Uint8Array) ||
    !(balance instanceof Uint8Array) ||
    !(storageRoot instanceof Uint8Array) ||
    !(codeHash instanceof Uint8Array)
  ) {
    throw new Error('Decoded account proof did not contain expected byte-array fields')
  }

  return {
    nonce,
    balance,
    storageRoot,
    codeHash
  }
}

class SingleRpcEthVerifier implements SingleRpcVerifier {
  private readonly config: SingleRpcVerifierConfig
  private readonly log?: (...args: any[]) => void

  constructor (config: SingleRpcVerifierConfig, options: SingleRpcVerifierOptions = {}) {
    this.config = config
    this.log = options.log
  }

  async prewarmVerificationDependencies (): Promise<void> {
    await Promise.all([
      loadProofTools(),
      loadHexTools()
    ])
  }

  private async getProofsBatch (addressesAndSlots: Array<{ address: string, storageKeys: string[] }>, blockNumber: string, signal?: AbortSignal): Promise<Proof[]> {
    const calls = addressesAndSlots.map(({ address, storageKeys }) => ({
      method: 'eth_getProof',
      params: [address, storageKeys, blockNumber] as unknown[]
    }))

    try {
      return await ethBatchCall<Proof>(this.config.rpcUrl, calls, signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err
      }

      return Promise.all(addressesAndSlots.map(async ({ address, storageKeys }) =>
        this.getProof(address, storageKeys, blockNumber, signal)
      ))
    }
  }

  private async getCodesBatch (addresses: string[], blockNumber: string, signal?: AbortSignal): Promise<Array<`0x${string}`>> {
    const calls = addresses.map(address => ({
      method: 'eth_getCode',
      params: [address, blockNumber] as unknown[]
    }))

    try {
      return await ethBatchCall<`0x${string}`>(this.config.rpcUrl, calls, signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err
      }

      return Promise.all(addresses.map(async address =>
        ethCall<`0x${string}`>(this.config.rpcUrl, 'eth_getCode', [address, blockNumber], signal)
      ))
    }
  }

  private async assertExpectedCodeHash (address: string, code: `0x${string}`, expectedCodeHash: Uint8Array): Promise<`0x${string}`> {
    const hexTools = await loadHexTools()
    const actualCodeHash = hexTools.keccak256(code)
    const expected = hexTools.bytesToHex(expectedCodeHash)

    if (actualCodeHash.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Code hash mismatch for ${address}: expected ${expected}, got ${actualCodeHash}`)
    }

    return code
  }

  async requestPinned<T> (method: string, params: unknown[], safeBlock: TrustedBlock, signal?: AbortSignal): Promise<T> {
    switch (method) {
      case 'eth_getCode': {
        assertParamCount(method, params, 2)
        assertSafeBlockNumberParam(method, params[1], safeBlock.number)
        const address = ensureHexAddress(params[0], 'eth_getCode')
        return this.getVerifiedCodeWithoutExpectedHash(address, safeBlock, signal) as T
      }
      case 'eth_call': {
        assertParamCount(method, params, 2)
        assertSafeBlockNumberParam(method, params[1], safeBlock.number)
        const tx = (params[0] ?? {}) as JsonRpcTransactionCall

        return this.executeVerifiedEthCall(tx, safeBlock, signal) as T
      }
      case 'eth_chainId':
      case 'eth_getBlockByNumber':
      case 'eth_getBalance':
      case 'eth_getTransactionCount':
      case 'eth_getStorageAt':
      case 'eth_createAccessList':
        throw new Error(`Method ${method} is not exposed via verified request path`)
      default:
        throw new Error(`Unsupported method in verified provider: ${method}`)
    }
  }

  private async getVerifiedCodeWithoutExpectedHash (address: string, safeBlock: TrustedBlock, signal?: AbortSignal): Promise<`0x${string}`> {
    const proof = await this.getProof(address, [], safeBlock.number, signal)
    const account = await this.verifyAccountProof(safeBlock, proof, address)
    if (account == null) {
      return '0x'
    }
    return this.getVerifiedCode(address, safeBlock.number, account.codeHash, signal)
  }

  private async buildVerifiedStateBundle (safeBlock: TrustedBlock, to: string, accessListTx: Record<string, string>, mergedAccessList: AccessListResult | null, signal?: AbortSignal): Promise<{ state: VerifiedStateBundle, accessList: AccessListResult }> {
    const freshAccessList = await this.getAccessList(accessListTx, safeBlock, signal)

    const combined = mergeAccessLists(mergedAccessList, freshAccessList)
    const byAddress = new Map<string, string[]>()

    for (const entry of combined.accessList) {
      byAddress.set(entry.address.toLowerCase(), entry.storageKeys)
    }

    if (!byAddress.has(to.toLowerCase())) {
      byAddress.set(to.toLowerCase(), [])
    }

    const proofs: Proof[] = []
    const codeByAddress: Record<string, `0x${string}`> = {}
    const addressesAndSlots = [...byAddress.entries()].map(([address, slots]) => ({ address, storageKeys: slots }))
    const proofChunks = chunkArray(addressesAndSlots, MAX_BATCH_SIZE)
    const chunkTasks = proofChunks.map(chunk => async (): Promise<void> => {
      const chunkProofs = await this.getProofsBatch(chunk, safeBlock.number, signal)
      const chunkAddresses = chunk.map(item => item.address)
      const chunkAccounts = await Promise.all(chunkProofs.map(async (proof, i) => this.verifyAccountProof(safeBlock, proof, chunkAddresses[i])))

      // verifyAccountProof already validated address/codeHash/storageHash against the trie.
      // Separate existing accounts from non-existent ones for code fetching.
      const addressesNeedingCode: string[] = []
      const accountsNeedingCode: VerifiedAccountState[] = []

      for (let i = 0; i < chunk.length; i++) {
        const account = chunkAccounts[i]
        if (account != null) {
          addressesNeedingCode.push(chunkAddresses[i])
          accountsNeedingCode.push(account)
        }
      }

      const chunkCodes = await this.getCodesBatch(addressesNeedingCode, safeBlock.number, signal)
      await Promise.all(chunkCodes.map(async (code, index) => this.assertExpectedCodeHash(addressesNeedingCode[index], code, accountsNeedingCode[index].codeHash)))

      for (let i = 0; i < chunk.length; i++) {
        const address = chunkAddresses[i]
        proofs.push({ ...chunkProofs[i], address: address as `0x${string}` })
        const codeIdx = addressesNeedingCode.indexOf(address)
        if (codeIdx !== -1) {
          codeByAddress[address] = chunkCodes[codeIdx]
        }
      }
    })

    await runWithConcurrency(chunkTasks, MAX_PARALLEL_ACCOUNT_BATCHES)

    return {
      state: { proofs, codeByAddress },
      accessList: combined
    }
  }

  private async executeVerifiedEthCall (tx: JsonRpcTransactionCall, safeBlock: TrustedBlock, signal?: AbortSignal): Promise<`0x${string}`> {
    const from = tx.from == null ? ZERO_ADDRESS : ensureHexAddress(tx.from, 'eth_call.from')
    const to = ensureHexAddress(tx.to, 'eth_call.to')
    const callData = ensureHexData(tx.data ?? '0x', 'eth_call.data')
    const valueHex = ensureHexQuantity(tx.value ?? '0x0', 'eth_call.value')
    const value = BigInt(valueHex)

    if (value !== 0n) {
      throw new Error('Verified eth_call only supports zero-value calls')
    }

    const callGasLimitHex = ensureHexQuantity(tx.gas ?? DEFAULT_CALL_GAS_LIMIT, 'eth_call.gas')

    const accessListTx: Record<string, string> = {
      from,
      to,
      data: callData,
      value: valueHex,
      gas: callGasLimitHex
    }

    if (tx.gasPrice != null) {
      accessListTx.gasPrice = ensureHexQuantity(tx.gasPrice, 'eth_call.gasPrice')
    }

    if (tx.maxFeePerGas != null) {
      accessListTx.maxFeePerGas = ensureHexQuantity(tx.maxFeePerGas, 'eth_call.maxFeePerGas')
    }

    if (tx.maxPriorityFeePerGas != null) {
      accessListTx.maxPriorityFeePerGas = ensureHexQuantity(tx.maxPriorityFeePerGas, 'eth_call.maxPriorityFeePerGas')
    }

    let accessList: AccessListResult | null = null
    let lastError: unknown

    for (let attempt = 0; attempt < MAX_VERIFIED_CALL_RETRIES; attempt++) {
      const bundle = await this.buildVerifiedStateBundle(safeBlock, to, accessListTx, accessList, signal)
      accessList = bundle.accessList

      try {
        return await executeVerifiedLocalCall({
          from,
          to,
          state: bundle.state,
          data: callData,
          value,
          callGasLimit: BigInt(callGasLimitHex),
          block: safeBlock
        })
      } catch (err) {
        lastError = err

        if (err instanceof LocalCallExecutionError) {
          throw err
        }

        if (!isRetryableLocalExecutionError(err) || attempt === MAX_VERIFIED_CALL_RETRIES - 1) {
          throw err
        }

        this.log?.('retrying verified eth_call for %s after attempt %d due to %s', to, attempt + 1, err instanceof Error ? err.message : String(err))
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async getProof (address: string, storageKeys: string[], blockNumber: string, signal?: AbortSignal): Promise<Proof> {
    return ethCall<Proof>(this.config.rpcUrl, 'eth_getProof', [address, storageKeys, blockNumber], signal)
  }

  private async getAccessList (transaction: Record<string, string>, safeBlock: TrustedBlock, signal?: AbortSignal): Promise<AccessListResult> {
    const baseFeePerGas = BigInt(safeBlock.baseFeePerGas ?? '0x0')
    const minPriorityFeePerGas = MIN_PRIORITY_FEE_PER_GAS
    const minFeePerGas = baseFeePerGas + minPriorityFeePerGas

    const txForAccessList: Record<string, string> = {
      ...transaction,
      value: transaction.value ?? '0x0',
      gas: transaction.gas ?? DEFAULT_CALL_GAS_LIMIT
    }

    const hasEip1559Fees = transaction.maxFeePerGas != null || transaction.maxPriorityFeePerGas != null

    if (hasEip1559Fees) {
      const maxFeePerGas = transaction.maxFeePerGas != null ? BigInt(transaction.maxFeePerGas) : 0n
      const maxPriorityFeePerGas = transaction.maxPriorityFeePerGas != null ? BigInt(transaction.maxPriorityFeePerGas) : 0n
      const effectiveMaxFeePerGas = maxFeePerGas > minFeePerGas ? maxFeePerGas : minFeePerGas
      const effectivePriorityFeePerGas = maxPriorityFeePerGas > minPriorityFeePerGas ? maxPriorityFeePerGas : minPriorityFeePerGas

      txForAccessList.maxFeePerGas = `0x${effectiveMaxFeePerGas.toString(16)}`
      txForAccessList.maxPriorityFeePerGas = `0x${effectivePriorityFeePerGas.toString(16)}`
      delete txForAccessList.gasPrice
    } else {
      const gasPrice = transaction.gasPrice != null ? BigInt(transaction.gasPrice) : 0n
      const effectiveGasPrice = gasPrice > minFeePerGas ? gasPrice : minFeePerGas

      txForAccessList.gasPrice = `0x${effectiveGasPrice.toString(16)}`
      delete txForAccessList.maxFeePerGas
      delete txForAccessList.maxPriorityFeePerGas
    }

    return ethCall<AccessListResult>(
      this.config.rpcUrl,
      'eth_createAccessList',
      [txForAccessList, safeBlock.number],
      signal
    )
  }

  private async verifyAccountProof (block: TrustedBlock, proof: Proof, expectedAddress: string): Promise<VerifiedAccountState | null> {
    const proofTools = await loadProofTools()
    const hexTools = await loadHexTools()

    this.log?.('verifying account proof for %s at block %s stateRoot=%s', expectedAddress, block.number, block.stateRoot)

    // Defensively reject a proof whose stated address differs from what we requested.
    // This surfaces substitution attacks rather than silently ignoring the mismatch.
    if (proof.address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(`Proof address mismatch for block ${block.number}: requested ${expectedAddress}, RPC returned proof for ${proof.address}`)
    }

    const accountProofNodes = proof.accountProof.map(node => hexTools.hexToBytes(node as `0x${string}`))
    // Use expectedAddress (the address we requested) as the trie key, not proof.address.
    // Even after the equality check above, keying on the canonical local value avoids any
    // case-normalisation difference in what the RPC returned.
    const addressBytes = hexTools.hexToBytes(expectedAddress as `0x${string}`)
    const stateRootBytes = hexTools.hexToBytes(block.stateRoot as `0x${string}`)

    let proofTrie: MerklePatriciaTrie
    try {
      proofTrie = await proofTools.createMPTFromProof(accountProofNodes, { root: stateRootBytes, useKeyHashing: true })
    } catch (err) {
      throw new Error(`Account proof createMPTFromProof failed for ${expectedAddress} at block ${block.number}: ${err instanceof Error ? err.message : String(err)}`)
    }

    let accountValue: Uint8Array | null
    try {
      accountValue = await proofTrie.get(addressBytes, false)
    } catch (err) {
      throw new Error(`Account proof trie.get failed for ${expectedAddress} at block ${block.number}: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (accountValue == null) {
      // Non-existent account: proof of non-membership verified. Return null so callers
      // can handle this as an empty account (balance=0, nonce=0, empty code, empty storage).
      return null
    }

    const state = decodeAccountState(accountValue, proofTools)

    // Cross-check proof fields against what the trie actually committed to. This turns
    // a silently-ignored field into a hard assertion, catching both dishonest RPCs and
    // corrupted responses before any of those values can influence further computation.
    const verifiedStorageHash = hexTools.bytesToHex(state.storageRoot)
    if (verifiedStorageHash.toLowerCase() !== proof.storageHash.toLowerCase()) {
      throw new Error(`Storage hash mismatch for ${expectedAddress} at block ${block.number}: state trie commits to ${verifiedStorageHash}, proof claims ${proof.storageHash}`)
    }

    const verifiedCodeHash = hexTools.bytesToHex(state.codeHash)
    if (verifiedCodeHash.toLowerCase() !== proof.codeHash.toLowerCase()) {
      throw new Error(`Code hash mismatch for ${expectedAddress} at block ${block.number}: state trie commits to ${verifiedCodeHash}, proof claims ${proof.codeHash}`)
    }

    // RLP encodes integers as minimal big-endian bytes; an empty byte array means 0.
    const trieNonce = state.nonce.length === 0 ? 0n : BigInt(hexTools.bytesToHex(state.nonce))
    const proofNonce = proof.nonce === '0x' ? 0n : BigInt(proof.nonce)
    if (trieNonce !== proofNonce) {
      throw new Error(`Nonce mismatch for ${expectedAddress} at block ${block.number}: state trie commits to ${trieNonce}, proof claims ${proof.nonce}`)
    }

    const trieBalance = state.balance.length === 0 ? 0n : BigInt(hexTools.bytesToHex(state.balance))
    const proofBalance = proof.balance === '0x' ? 0n : BigInt(proof.balance)
    if (trieBalance !== proofBalance) {
      throw new Error(`Balance mismatch for ${expectedAddress} at block ${block.number}: state trie commits to ${trieBalance}, proof claims ${proof.balance}`)
    }

    return state
  }

  private async getVerifiedCode (address: string, blockNumber: string, expectedCodeHash: Uint8Array, signal?: AbortSignal): Promise<`0x${string}`> {
    const hexTools = await loadHexTools()
    const code = await ethCall<`0x${string}`>(this.config.rpcUrl, 'eth_getCode', [address, blockNumber], signal)
    const actualCodeHash = hexTools.keccak256(code)
    const expected = hexTools.bytesToHex(expectedCodeHash)

    if (actualCodeHash.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Code hash mismatch for ${address}: expected ${expected}, got ${actualCodeHash}`)
    }

    return code
  }
}

export function createSingleRpcVerifier (config: SingleRpcVerifierConfig, options: SingleRpcVerifierOptions = {}): SingleRpcVerifier {
  return new SingleRpcEthVerifier(config, options)
}
