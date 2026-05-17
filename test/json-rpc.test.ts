import assert from 'node:assert/strict'
import test from 'node:test'
import { ethBatchCall, ethCall } from '../src/json-rpc.ts'

function withMockFetch (responseBody: unknown, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (): Promise<Response> => {
    return new Response(JSON.stringify(responseBody), { status: 200 })
  }) as typeof fetch

  return run().finally(() => {
    globalThis.fetch = originalFetch
  })
}

test('ethCall rejects responses missing result and error', async () => {
  await withMockFetch({ jsonrpc: '2.0', id: 1 }, async () => {
    await assert.rejects(
      async () => ethCall('https://rpc.example', 'eth_chainId', []),
      /malformed response.*missing result/
    )
  })
})

test('ethCall accepts explicit null results', async () => {
  await withMockFetch({ jsonrpc: '2.0', id: 1, result: null }, async () => {
    const result = await ethCall<null>('https://rpc.example', 'eth_getBlockByNumber', ['0x1', false])
    assert.equal(result, null)
  })
})

test('ethBatchCall rejects batch items missing result and error', async () => {
  await withMockFetch([{ jsonrpc: '2.0', id: 1 }], async () => {
    await assert.rejects(
      async () => ethBatchCall('https://rpc.example', [{ method: 'eth_getCode', params: ['0x1', '0x2'] }]),
      /malformed batch response.*missing result/
    )
  })
})
