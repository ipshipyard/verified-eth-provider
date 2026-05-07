import { executeVerifiedLocalCall, LocalCallExecutionError } from './verified-local-call.ts'
import type { VerifiedStateBundle } from './verified-local-call.ts'
import {
  type AccessListResult,
  chunkArray,
  ensureHexAddress,
  ensureHexData,
  isRetryableLocalExecutionError,
  mergeAccessLists,
  pinRpcMethodToBlock,
  runWithConcurrency
} from './helpers.ts'
import type {
  TrustedBlock
} from './types.ts'

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

interface VerifiedAccountState {
  storageRoot: Uint8Array
  codeHash: Uint8Array
}

interface SingleRpcVerifierConfig {
  rpcUrl: string
}

interface SingleRpcVerifierOptions {
  log?: (...args: any[]) => void
}

interface SingleRpcVerifier {
  requestPinned<T>(method: string, params: unknown[], safeBlock: TrustedBlock, signal?: AbortSignal): Promise<T>
  prewarmVerificationDependencies(): Promise<void>
  getProof(address: string, storageKeys: string[], blockNumber: string, signal?: AbortSignal): Promise<Eip1186Proof>
  getAccessList(transaction: Record<string, string>, blockNumber: string, signal?: AbortSignal): Promise<AccessListResult>
  assertAccessListSupport(transaction: Record<string, string>, blockNumber: string, signal?: AbortSignal): Promise<void>
  verifyAccountProof(block: TrustedBlock, proof: Eip1186Proof): Promise<VerifiedAccountState>
  verifyStorageProof(storageRoot: Uint8Array, slotKey: string, storageProof: Eip1186StorageProof): Promise<Uint8Array | null>
  getVerifiedCode(address: string, blockNumber: string, expectedCodeHash: Uint8Array, signal?: AbortSignal): Promise<`0x${string}`>
}

interface JsonRpcResponse<T> {
  result: T
  error?: { code: number, message: string }
}

interface JsonRpcRequest {
  id: number
  jsonrpc: '2.0'
  method: string
  params: unknown[]
}

interface JsonRpcBatchResponse<T> {
  id: number
  result?: T
  error?: { code: number, message: string }
}

interface JsonRpcTransactionCall {
  from?: string
  to?: string
  data?: string
}

interface TrieInstance {
  get: (key: Uint8Array, throwIfMissing?: boolean) => Promise<Uint8Array | null>
}

interface TrieClass {
  verifyProof: (key: Uint8Array, proof: Uint8Array[], opts?: Record<string, any>) => Promise<Uint8Array | null>
  createFromProof: (proof: Uint8Array[], opts?: Record<string, any>) => Promise<TrieInstance>
}

interface ProofTools {
  Trie: TrieClass
  rlpDecode: (input: Uint8Array) => any
}

interface HexTools {
  hexToBytes: (value: `0x${string}`) => Uint8Array
  bytesToHex: (value: Uint8Array) => `0x${string}`
  keccak256: (value: `0x${string}`) => `0x${string}`
}

const MAX_VERIFIED_CALL_RETRIES = 3
const MAX_BATCH_SIZE = 8
const MAX_PARALLEL_ACCOUNT_BATCHES = 4
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MAINNET_CHAIN_ID_HEX = '0x1'

let proofToolsCache: ProofTools | null = null
let hexToolsCache: HexTools | null = null

async function loadProofTools (): Promise<ProofTools> {
  if (proofToolsCache != null) {
    return proofToolsCache
  }

  const [
    { Trie },
    { decode: rlpDecode }
  ] = await Promise.all([
    import('@ethereumjs/trie'),
    import('@ethereumjs/rlp')
  ])

  const tools: ProofTools = {
    Trie,
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

async function ethBatchCall<T> (url: string, calls: Array<{ method: string, params: unknown[] }>, signal?: AbortSignal): Promise<T[]> {
  if (calls.length === 0) {
    return []
  }

  const requests: JsonRpcRequest[] = calls.map((call, index) => ({
    id: index + 1,
    jsonrpc: '2.0',
    method: call.method,
    params: call.params
  }))

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requests),
    signal
  })

  if (!response.ok) {
    throw new Error(`RPC ${url} returned HTTP ${response.status} for batch call (${calls.length} requests)`)
  }

  const body = await response.json() as JsonRpcBatchResponse<T>[]

  if (!Array.isArray(body)) {
    throw new Error(`RPC ${url} returned non-batch payload for batch call (${calls.length} requests)`)
  }

  const byId = new Map<number, JsonRpcBatchResponse<T>>()

  for (const item of body) {
    byId.set(item.id, item)
  }

  return requests.map(request => {
    const item = byId.get(request.id)

    if (item == null) {
      throw new Error(`RPC ${url} batch response missing id=${request.id} for ${request.method}`)
    }

    if (item.error != null) {
      throw new Error(`RPC ${url} error for ${request.method} in batch: ${item.error.message}`)
    }

    return item.result as T
  })
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

function decodeAccountState (accountRlpValue: Uint8Array, proofTools: ProofTools): VerifiedAccountState {
  const decoded = proofTools.rlpDecode(accountRlpValue)

  if (!Array.isArray(decoded) || decoded.length < 4) {
    throw new Error('Failed to decode account value from account proof')
  }

  const storageRoot = decoded[2]
  const codeHash = decoded[3]

  if (!(storageRoot instanceof Uint8Array) || !(codeHash instanceof Uint8Array)) {
    throw new Error('Decoded account proof did not contain byte-array storageRoot/codeHash')
  }

  return {
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

  private async getProofsBatch (addressesAndSlots: Array<{ address: string, storageKeys: string[] }>, blockNumber: string, signal?: AbortSignal): Promise<Eip1186Proof[]> {
    const calls = addressesAndSlots.map(({ address, storageKeys }) => ({
      method: 'eth_getProof',
      params: [address, storageKeys, blockNumber] as unknown[]
    }))

    try {
      return await ethBatchCall<Eip1186Proof>(this.config.rpcUrl, calls, signal)
    } catch {
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
    } catch {
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
    const pinnedParams = pinRpcMethodToBlock(method, params, safeBlock.number)

    switch (method) {
      case 'eth_chainId':
        await assertMainnet(this.config.rpcUrl, signal)
        return MAINNET_CHAIN_ID_HEX as T
      case 'eth_getBlockByNumber':
        return safeBlock as T
      case 'eth_getCode': {
        const address = ensureHexAddress(pinnedParams[0], 'eth_getCode')
        return this.getVerifiedCodeWithoutExpectedHash(address, safeBlock, signal) as T
      }
      case 'eth_getProof': {
        const address = ensureHexAddress(pinnedParams[0], 'eth_getProof')
        const storageKeys = Array.isArray(pinnedParams[1]) ? pinnedParams[1] : []
        return this.getProofWithVerification(address, storageKeys as string[], safeBlock, signal) as T
      }
      case 'eth_call': {
        const tx = (pinnedParams[0] ?? {}) as JsonRpcTransactionCall

        if (pinnedParams[2] != null) {
          throw new Error('eth_call state override is not supported for verified execution')
        }

        return this.executeVerifiedEthCall(tx, safeBlock, signal) as T
      }
      case 'eth_getBalance':
      case 'eth_getTransactionCount':
      case 'eth_getStorageAt':
      case 'eth_createAccessList':
        throw new Error(`Method ${method} is not exposed via verified request path`)
      default:
        throw new Error(`Unsupported method in verified provider: ${method}`)
    }
  }

  private async getProofWithVerification (address: string, storageKeys: string[], safeBlock: TrustedBlock, signal?: AbortSignal): Promise<Eip1186Proof> {
    const proof = await this.getProof(address, storageKeys, safeBlock.number, signal)
    const account = await this.verifyAccountProof(safeBlock, proof)

    for (const slotProof of proof.storageProof) {
      await this.verifyStorageProof(account.storageRoot, slotProof.key, slotProof)
    }

    return proof
  }

  private async getVerifiedCodeWithoutExpectedHash (address: string, safeBlock: TrustedBlock, signal?: AbortSignal): Promise<`0x${string}`> {
    const proof = await this.getProof(address, [], safeBlock.number, signal)
    const account = await this.verifyAccountProof(safeBlock, proof)
    return this.getVerifiedCode(address, safeBlock.number, account.codeHash, signal)
  }

  private async buildVerifiedStateBundle (safeBlock: TrustedBlock, to: string, callData: `0x${string}`, mergedAccessList: AccessListResult | null, signal?: AbortSignal): Promise<{ state: VerifiedStateBundle, accessList: AccessListResult }> {
    const freshAccessList = await this.getAccessList({
      from: ZERO_ADDRESS,
      to,
      data: callData
    }, safeBlock.number, signal, safeBlock)

    const combined = mergeAccessLists(mergedAccessList, freshAccessList)
    const byAddress = new Map<string, string[]>()

    for (const entry of combined.accessList) {
      byAddress.set(entry.address.toLowerCase(), entry.storageKeys)
    }

    if (!byAddress.has(to.toLowerCase())) {
      byAddress.set(to.toLowerCase(), [])
    }

    const proofs: Eip1186Proof[] = []
    const codeByAddress: Record<string, `0x${string}`> = {}
    const addressesAndSlots = [...byAddress.entries()].map(([address, slots]) => ({ address, storageKeys: slots }))
    const proofChunks = chunkArray(addressesAndSlots, MAX_BATCH_SIZE)
    const chunkTasks = proofChunks.map(chunk => async (): Promise<void> => {
      const chunkProofs = await this.getProofsBatch(chunk, safeBlock.number, signal)
      const chunkAccounts = await Promise.all(chunkProofs.map(async proof => this.verifyAccountProof(safeBlock, proof)))
      const chunkAddresses = chunk.map(item => item.address)
      const chunkCodes = await this.getCodesBatch(chunkAddresses, safeBlock.number, signal)

      await Promise.all(chunkCodes.map(async (code, index) => this.assertExpectedCodeHash(chunkAddresses[index], code, chunkAccounts[index].codeHash)))

      for (let i = 0; i < chunk.length; i++) {
        const address = chunkAddresses[i]
        proofs.push({ ...chunkProofs[i], address })
        codeByAddress[address] = chunkCodes[i]
      }
    })

    await runWithConcurrency(chunkTasks, MAX_PARALLEL_ACCOUNT_BATCHES)

    return {
      state: { proofs, codeByAddress },
      accessList: combined
    }
  }

  private async executeVerifiedEthCall (tx: JsonRpcTransactionCall, safeBlock: TrustedBlock, signal?: AbortSignal): Promise<`0x${string}`> {
    const to = ensureHexAddress(tx.to, 'eth_call.to')
    const callData = ensureHexData(tx.data ?? '0x', 'eth_call.data')

    let accessList: AccessListResult | null = null
    let lastError: unknown

    for (let attempt = 0; attempt < MAX_VERIFIED_CALL_RETRIES; attempt++) {
      const bundle = await this.buildVerifiedStateBundle(safeBlock, to, callData, accessList, signal)
      accessList = bundle.accessList

      try {
        return await executeVerifiedLocalCall({
          to,
          state: bundle.state,
          data: callData
        })
      } catch (err) {
        lastError = err

        if (err instanceof LocalCallExecutionError) {
          if (err.reason === 'out-of-gas' && attempt < MAX_VERIFIED_CALL_RETRIES - 1) {
            this.log?.('retrying verified eth_call for %s after attempt %d due to local execution %s', to, attempt + 1, err.reason)
            continue
          }

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

  async getProof (address: string, storageKeys: string[], blockNumber: string, signal?: AbortSignal): Promise<Eip1186Proof> {
    return ethCall<Eip1186Proof>(this.config.rpcUrl, 'eth_getProof', [address, storageKeys, blockNumber], signal)
  }

  async getAccessList (transaction: Record<string, string>, blockNumber: string, signal?: AbortSignal, knownBlock?: TrustedBlock): Promise<AccessListResult> {
    const block = knownBlock ?? await getBlockByNumber(this.config.rpcUrl, blockNumber, signal)
    const baseFeePerGas = BigInt(block.baseFeePerGas ?? '0x0')
    const minPriorityFeePerGas = 1_000_000_000n
    const minFeePerGas = baseFeePerGas + minPriorityFeePerGas

    const txForAccessList: Record<string, string> = {
      ...transaction,
      value: transaction.value ?? '0x0',
      gas: transaction.gas ?? '0xf4240'
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
      [txForAccessList, blockNumber],
      signal
    )
  }

  async assertAccessListSupport (transaction: Record<string, string>, blockNumber: string, signal?: AbortSignal): Promise<void> {
    await this.getAccessList(transaction, blockNumber, signal)
  }

  async verifyAccountProof (block: TrustedBlock, proof: Eip1186Proof): Promise<VerifiedAccountState> {
    const proofTools = await loadProofTools()
    const hexTools = await loadHexTools()

    this.log?.('verifying account proof for %s at block %s stateRoot=%s', proof.address, block.number, block.stateRoot)

    const accountProofNodes = proof.accountProof.map(node => hexTools.hexToBytes(node as `0x${string}`))
    const addressBytes = hexTools.hexToBytes(proof.address as `0x${string}`)
    const stateRootBytes = hexTools.hexToBytes(block.stateRoot as `0x${string}`)

    let proofTrie: TrieInstance
    try {
      proofTrie = await proofTools.Trie.createFromProof(accountProofNodes, { root: stateRootBytes, useKeyHashing: true })
    } catch (err) {
      throw new Error(`Account proof createFromProof failed for ${proof.address} at block ${block.number}: ${err instanceof Error ? err.message : String(err)}`)
    }

    let accountValue: Uint8Array | null
    try {
      accountValue = await proofTrie.get(addressBytes, false)
    } catch (err) {
      throw new Error(`Account proof trie.get failed for ${proof.address} at block ${block.number}: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (accountValue == null) {
      throw new Error(`Account proof verified as non-existent for ${proof.address} at block ${block.number}`)
    }

    return decodeAccountState(accountValue, proofTools)
  }

  async verifyStorageProof (storageRoot: Uint8Array, slotKey: string, storageProof: Eip1186StorageProof): Promise<Uint8Array | null> {
    const proofTools = await loadProofTools()
    const hexTools = await loadHexTools()
    const storageProofNodes = storageProof.proof.map(node => hexTools.hexToBytes(node as `0x${string}`))

    return proofTools.Trie.verifyProof(
      hexTools.hexToBytes(slotKey as `0x${string}`),
      storageProofNodes,
      {
        root: storageRoot,
        useKeyHashing: true
      }
    )
  }

  async getVerifiedCode (address: string, blockNumber: string, expectedCodeHash: Uint8Array, signal?: AbortSignal): Promise<`0x${string}`> {
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

export async function createSingleRpcVerifier (config: SingleRpcVerifierConfig, options: SingleRpcVerifierOptions = {}): Promise<SingleRpcVerifier> {
  return new SingleRpcEthVerifier(config, options)
}