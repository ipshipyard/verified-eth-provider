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
  hash: `0x${'ab'.repeat(32)}`,
  timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
  stateRoot: `0x${'cd'.repeat(32)}`,
  baseFeePerGas: '0x1',
  gasLimit: '0x1c9c380',
  miner: '0x0000000000000000000000000000000000000000',
  mixHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
}

test('createVerifiedTransport accepts static trusted block', async () => {
  const transport = await createVerifiedTransport({
    rpcUrl: PRIMARY,
    trustedBlock
  })

  assert.equal(transport.trustedBlock.hash, trustedBlock.hash)
  assert.equal(transport.trustedBlock.number, trustedBlock.number)
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
  assert.equal(transport.trustedBlock.hash, trustedBlock.hash)
})

test('createVerifiedTransport rejects mismatched block parameters on supported methods', async () => {
  const transport = await createVerifiedTransport({
    rpcUrl: PRIMARY,
    trustedBlock
  })

  const client = createPublicClient({ transport })

  await assert.rejects(
    async () => await client.request({ method: 'eth_call', params: [{ to: '0x1111111111111111111111111111111111111111', data: '0x' }, '0x999'] }),
    /must match trusted block/
  )

  await assert.rejects(
    async () => await client.request({ method: 'eth_getCode', params: ['0x1111111111111111111111111111111111111111', 'latest'] }),
    /must match trusted block/
  )
})

test('createVerifiedTransport rejects invalid parameter counts on supported methods', async () => {
  const transport = await createVerifiedTransport({
    rpcUrl: PRIMARY,
    trustedBlock
  })

  const client = createPublicClient({ transport })

  await assert.rejects(
    async () => await client.request({ method: 'eth_chainId' as any, params: [] as any }),
    /not exposed via verified request path/
  )

  await assert.rejects(
    async () => await client.request({ method: 'eth_call', params: [{ to: '0x1111111111111111111111111111111111111111', data: '0x' }, trustedBlock.number as `0x${string}`, {}] }),
    /expects exactly 2 parameter/
  )
})

test('createVerifiedTransport rejects non-zero-value eth_call requests', async () => {
  const transport = await createVerifiedTransport({
    rpcUrl: PRIMARY,
    trustedBlock
  })

  const client = createPublicClient({ transport })

  await assert.rejects(
    async () => await client.request({ method: 'eth_call', params: [{ to: '0x1111111111111111111111111111111111111111', value: '0x1' }, trustedBlock.number as `0x${string}`] }),
    /zero-value calls/
  )
})
