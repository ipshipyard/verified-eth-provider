import assert from 'node:assert/strict'
import test from 'node:test'
import { createQuorumTrustedBlockSelector } from '../src/trusted-block-selector.ts'

interface MockRule {
  url: string
  method: string
  result?: unknown
  error?: { code: number, message: string }
}

function withMockFetch (rules: MockRule[], run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string, id?: number }
    const rule = rules.find(item => item.url === url && item.method === body.method)

    if (rule == null) {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id ?? 1,
        error: { code: -32601, message: `No mock for ${url} ${body.method}` }
      }), { status: 200 })
    }

    if (rule.error != null) {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id ?? 1,
        error: rule.error
      }), { status: 200 })
    }

    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id ?? 1,
      result: rule.result
    }), { status: 200 })
  }) as typeof fetch

  return run().finally(() => {
    globalThis.fetch = originalFetch
  })
}

const PRIMARY = 'https://primary.example/rpc'
const WITNESS_A = 'https://witness-a.example/rpc'
const WITNESS_B = 'https://witness-b.example/rpc'

const nowSeconds = Math.floor(Date.now() / 1000)

const block = {
  number: '0x100',
  hash: '0xabc123',
  timestamp: `0x${nowSeconds.toString(16)}`,
  stateRoot: '0xdef456',
  baseFeePerGas: '0x1'
}

test('createQuorumTrustedBlockSelector returns safe block when all RPCs agree', async () => {
  await withMockFetch([
    { url: PRIMARY, method: 'eth_chainId', result: '0x1' },
    { url: WITNESS_A, method: 'eth_chainId', result: '0x1' },
    { url: WITNESS_B, method: 'eth_chainId', result: '0x1' },
    { url: PRIMARY, method: 'eth_getBlockByNumber', result: block },
    { url: WITNESS_A, method: 'eth_getBlockByNumber', result: block },
    { url: WITNESS_B, method: 'eth_getBlockByNumber', result: block }
  ], async () => {
    const selector = await createQuorumTrustedBlockSelector({
      primaryRpc: PRIMARY,
      witnessRpcs: [WITNESS_A, WITNESS_B],
      maxSafeBlockAgeMs: 1_000_000
    })

    const trusted = await selector()
    assert.equal(trusted.hash, block.hash)
    assert.equal(trusted.number, block.number)
  })
})

test('createQuorumTrustedBlockSelector rejects when witness hash mismatches', async () => {
  await withMockFetch([
    { url: PRIMARY, method: 'eth_chainId', result: '0x1' },
    { url: WITNESS_A, method: 'eth_chainId', result: '0x1' },
    { url: WITNESS_B, method: 'eth_chainId', result: '0x1' },
    { url: PRIMARY, method: 'eth_getBlockByNumber', result: block },
    { url: WITNESS_A, method: 'eth_getBlockByNumber', result: { ...block, hash: '0xbeef' } },
    { url: WITNESS_B, method: 'eth_getBlockByNumber', result: block }
  ], async () => {
    const selector = await createQuorumTrustedBlockSelector({
      primaryRpc: PRIMARY,
      witnessRpcs: [WITNESS_A, WITNESS_B],
      maxSafeBlockAgeMs: 1_000_000
    })

    await assert.rejects(
      async () => selector(),
      /Witness A/
    )
  })
})

test('createQuorumTrustedBlockSelector rejects non-mainnet RPC', async () => {
  await withMockFetch([
    { url: PRIMARY, method: 'eth_chainId', result: '0xaa36a7' },
    { url: WITNESS_A, method: 'eth_chainId', result: '0x1' },
    { url: WITNESS_B, method: 'eth_chainId', result: '0x1' }
  ], async () => {
    const selector = await createQuorumTrustedBlockSelector({
      primaryRpc: PRIMARY,
      witnessRpcs: [WITNESS_A, WITNESS_B],
      maxSafeBlockAgeMs: 1_000_000
    })

    await assert.rejects(
      async () => selector(),
      /not mainnet/
    )
  })
})