import type { TrustedBlock } from './types.ts'

export interface AccessListEntry {
  address: string
  storageKeys: string[]
}

export interface AccessListResult {
  accessList: AccessListEntry[]
}

// Zero tolerance: any block whose timestamp is in our future is rejected outright.
// Block producers set timestamps ~1 s ahead, but the *safe* block tag is always
// finality-confirmed and should never arrive with a future timestamp on a healthy node.
const MAX_FUTURE_BLOCK_SKEW_MS = 0

export function chunkArray<T> (values: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    throw new Error(`Invalid chunk size: ${chunkSize}`)
  }

  const chunks: T[][] = []

  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize))
  }

  return chunks
}

export async function runWithConcurrency<T> (tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  if (tasks.length === 0) {
    return []
  }

  const clampedConcurrency = Math.max(1, Math.min(concurrency, tasks.length))
  const results = new Array<T>(tasks.length)
  let nextIndex = 0

  async function worker (): Promise<void> {
    while (true) {
      const current = nextIndex
      nextIndex += 1

      if (current >= tasks.length) {
        return
      }

      results[current] = await tasks[current]()
    }
  }

  await Promise.all(Array.from({ length: clampedConcurrency }, () => worker()))

  return results
}

export function ensureHexQuantity (value: unknown, field: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error(`Invalid ${field} hex quantity for verified request`)
  }

  return value.toLowerCase() as `0x${string}`
}

export function assertBlockFreshness (block: TrustedBlock, maxBlockAgeMs: number, nowMs: number = Date.now()): void {
  // Block timestamp is in seconds; all values fit safely in Number (< 2^53).
  const blockMs = Number(block.timestamp) * 1000
  const ageMs = nowMs - blockMs

  if (ageMs > maxBlockAgeMs) {
    throw new Error(`Safe block ${block.number} is ${Math.floor(ageMs / 1000)}s old (max ${maxBlockAgeMs / 1000}s)`)
  }

  if (ageMs < 0) {
    throw new Error(`Safe block ${block.number} is dated ${Math.floor(-ageMs / 1000)}s in the future (max skew ${MAX_FUTURE_BLOCK_SKEW_MS / 1000}s)`)
  }
}

export function mergeAccessLists (previous: AccessListResult | null, next: AccessListResult): AccessListResult {
  if (previous == null) {
    return next
  }

  const byAddress = new Map<string, Set<string>>()

  for (const entry of previous.accessList) {
    byAddress.set(entry.address.toLowerCase(), new Set(entry.storageKeys))
  }

  for (const entry of next.accessList) {
    const key = entry.address.toLowerCase()
    const slots = byAddress.get(key) ?? new Set<string>()

    for (const slot of entry.storageKeys) {
      slots.add(slot)
    }

    byAddress.set(key, slots)
  }

  return {
    accessList: [...byAddress.entries()].map(([address, slots]) => ({
      address,
      storageKeys: [...slots]
    }))
  }
}

export function isRetryableLocalExecutionError (err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()

  // @ethereumjs/mpt throws 'Missing node in DB' when the EVM reads a storage slot
  // that was not included in the proof set. This is retryable — we re-fetch with
  // an expanded access list and try again.
  return message.includes('missing node in db')
}

export function ensureHexAddress (value: unknown, field: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`Invalid ${field} address for verified request`)
  }

  return value.toLowerCase() as `0x${string}`
}

export function ensureHexData (value: unknown, field: string, expectedByteLength?: number): `0x${string}` {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`Invalid ${field} hex data for verified request`)
  }

  const hex = value.slice(2)

  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error(`Invalid ${field} hex data for verified request`)
  }

  if (expectedByteLength != null && hex.length !== expectedByteLength * 2) {
    throw new Error(`Invalid ${field} hex data for verified request`)
  }

  return value.toLowerCase() as `0x${string}`
}

/**
 * Validates all fields of a {@link TrustedBlock}, throwing if any are malformed.
 */
export function validateTrustedBlock (block: TrustedBlock): TrustedBlock {
  return {
    number: ensureHexQuantity(block.number, 'number'),
    hash: ensureHexData(block.hash, 'hash', 32),
    timestamp: ensureHexQuantity(block.timestamp, 'timestamp'),
    stateRoot: ensureHexData(block.stateRoot, 'stateRoot', 32),
    baseFeePerGas: block.baseFeePerGas != null ? ensureHexQuantity(block.baseFeePerGas, 'baseFeePerGas') : undefined,
    gasLimit: ensureHexQuantity(block.gasLimit, 'gasLimit'),
    miner: ensureHexAddress(block.miner, 'miner'),
    mixHash: ensureHexData(block.mixHash, 'mixHash', 32)
  }
}
