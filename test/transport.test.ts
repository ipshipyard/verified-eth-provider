import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublicClient } from 'viem'
import { createVerifiedTransport } from '../src/index.ts'

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

const trustedBlock = {
  number: '0x100',
  hash: '0xabc123',
  timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
  stateRoot: '0xdef456',
  baseFeePerGas: '0x1'
}

test('createVerifiedTransport accepts static trusted block', async () => {
  const transport = await createVerifiedTransport({
    rpcUrl: PRIMARY,
    trustedBlock
  })

  const client = createPublicClient({ transport })
  const block = await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })

  assert.deepEqual(block, trustedBlock)
  assert.equal(transport.trustedBlock.hash, trustedBlock.hash)
  await assert.doesNotReject(async () => transport.prewarmVerificationDependencies())
})

test('createVerifiedTransport accepts async trusted block provider', async () => {
  let trustedBlockCalls = 0

  const transport = await createVerifiedTransport({
    rpcUrl: PRIMARY,
    trustedBlock: async () => {
      trustedBlockCalls += 1
      return trustedBlock
    }
  })

  assert.equal(trustedBlockCalls, 1)

  const client = createPublicClient({ transport })
  const block = await client.request({ method: 'eth_getBlockByNumber', params: ['pending', false] })

  assert.deepEqual(block, trustedBlock)
})

test('createVerifiedTransport still routes eth_chainId through verifier checks', async () => {
  await withMockFetch([
    { url: PRIMARY, method: 'eth_chainId', result: '0x1' }
  ], async () => {
    const transport = await createVerifiedTransport({
      rpcUrl: PRIMARY,
      trustedBlock
    })

    const client = createPublicClient({ transport })
    const chainId = await client.request({ method: 'eth_chainId', params: [] })

    assert.equal(chainId, '0x1')
  })
})
