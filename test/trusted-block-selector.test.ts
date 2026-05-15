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
  hash: `0x${'ab'.repeat(32)}`,
  timestamp: `0x${nowSeconds.toString(16)}`,
  stateRoot: `0x${'cd'.repeat(32)}`,
  baseFeePerGas: '0x1',
  gasLimit: '0x1c9c380',
  miner: '0x0000000000000000000000000000000000000000',
  mixHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
}

test('createQuorumTrustedBlockSelector returns safe block when all RPCs agree', async () => {
  await withMockFetch([
    { url: PRIMARY, method: 'eth_getBlockByNumber', result: { ...block, nonce: '0x0', extraData: '0x1234' } },
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
    const trustedData = trusted as unknown as Record<string, unknown>
    assert.equal('nonce' in trustedData, false)
    assert.equal('extraData' in trustedData, false)
  })
})

test('createQuorumTrustedBlockSelector uses the configured blockTag for the primary RPC call', async () => {
  let capturedPrimaryParam: string | undefined

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string, params?: unknown[], id?: number }
    if (url === PRIMARY && body.method === 'eth_getBlockByNumber') {
      capturedPrimaryParam = body.params?.[0] as string
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result: block }), { status: 200 })
  }) as typeof fetch

  try {
    for (const tag of ['latest', 'safe', 'finalized'] as const) {
      capturedPrimaryParam = undefined
      const selector = createQuorumTrustedBlockSelector({
        primaryRpc: PRIMARY,
        witnessRpcs: [WITNESS_A, WITNESS_B],
        maxSafeBlockAgeMs: 1_000_000,
        blockTag: tag
      })
      await selector()
      assert.equal(capturedPrimaryParam, tag)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('createQuorumTrustedBlockSelector rejects when witness trusted block fields mismatch', async () => {
  await withMockFetch([
    { url: PRIMARY, method: 'eth_getBlockByNumber', result: block },
    { url: WITNESS_A, method: 'eth_getBlockByNumber', result: { ...block, timestamp: '0x1' } },
    { url: WITNESS_B, method: 'eth_getBlockByNumber', result: block }
  ], async () => {
    const selector = await createQuorumTrustedBlockSelector({
      primaryRpc: PRIMARY,
      witnessRpcs: [WITNESS_A, WITNESS_B],
      maxSafeBlockAgeMs: 1_000_000
    })

    await assert.rejects(
      async () => selector(),
      /timestamp .* does not match primary/
    )
  })
})
