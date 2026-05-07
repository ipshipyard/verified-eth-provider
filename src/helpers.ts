import type { TrustedBlock } from './types.ts'

export interface AccessListEntry {
  address: string
  storageKeys: string[]
}

export interface AccessListResult {
  accessList: AccessListEntry[]
}

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

export function assertBlockFreshness (block: TrustedBlock, maxBlockAgeMs: number, nowMs: number = Date.now()): void {
  const blockTimestampMs = parseInt(block.timestamp, 16) * 1000
  const ageMs = nowMs - blockTimestampMs

  if (ageMs > maxBlockAgeMs) {
    throw new Error(`Safe block ${block.number} timestamp is ${Math.round(ageMs / 1000)}s old (max ${maxBlockAgeMs / 1000}s)`)
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
  return message.includes('missing')
}

export function ensureHexAddress (value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.startsWith('0x') || value.length !== 42) {
    throw new Error(`Invalid ${field} address for verified request`)
  }

  return value.toLowerCase()
}

export function ensureHexData (value: unknown, field: string): `0x${string}` {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`Invalid ${field} hex data for verified request`)
  }

  return value as `0x${string}`
}

export function pinRpcMethodToBlock (method: string, params: unknown[] | undefined, safeBlockNumber: string): unknown[] {
  const p = params ?? []

  switch (method) {
    case 'eth_call': {
      const tx = p[0]
      const stateOverride = p[2]
      if (stateOverride == null) {
        return [tx, safeBlockNumber]
      }
      return [tx, safeBlockNumber, stateOverride]
    }
    case 'eth_getBlockByNumber':
      return [safeBlockNumber, false]
    case 'eth_getCode':
    case 'eth_getBalance':
    case 'eth_getTransactionCount':
      return [p[0], safeBlockNumber]
    case 'eth_getStorageAt':
      return [p[0], p[1], safeBlockNumber]
    case 'eth_getProof':
      return [p[0], p[1] ?? [], safeBlockNumber]
    case 'eth_createAccessList':
      return [p[0], safeBlockNumber]
    default:
      return p
  }
}