import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublicClient } from 'viem'
import { createVerifiedTransport } from '../src/index.ts'

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

test('createVerifiedTransport rejects mismatched explicit block numbers on supported methods', async () => {
  const transport = await createVerifiedTransport({
    rpcUrl: PRIMARY,
    trustedBlock
  })

  const client = createPublicClient({ transport })

  await assert.rejects(
    async () => client.request({ method: 'eth_call', params: [{ to: '0x1111111111111111111111111111111111111111', data: '0x' }, '0x999'] }),
    /must match trusted block/
  )
})

test('createVerifiedTransport normalizes "latest" and "safe" block tags to the trusted block', async () => {
  const transport = await createVerifiedTransport({
    rpcUrl: PRIMARY,
    trustedBlock
  })

  const client = createPublicClient({ transport })

  // Both "latest" and "safe" should be accepted (normalized to the trusted block number).
  // The calls will fail further down the verification stack — not with a block-mismatch error.
  for (const tag of ['latest', 'safe', 'finalized'] as const) {
    await assert.rejects(
      async () => client.request({ method: 'eth_getCode', params: ['0x1111111111111111111111111111111111111111', tag] }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.doesNotMatch(err.message, /must match trusted block/)
        return true
      }
    )
  }
})

test('createVerifiedTransport rejects invalid parameter counts on supported methods', async () => {
  const transport = await createVerifiedTransport({
    rpcUrl: PRIMARY,
    trustedBlock
  })

  const client = createPublicClient({ transport })

  await assert.rejects(
    async () => client.request({ method: 'eth_chainId' as any, params: [] as any }),
    /not exposed via verified request path/
  )

  await assert.rejects(
    async () => client.request({ method: 'eth_call', params: [{ to: '0x1111111111111111111111111111111111111111', data: '0x' }, trustedBlock.number as `0x${string}`, {}] }),
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
    async () => client.request({ method: 'eth_call', params: [{ to: '0x1111111111111111111111111111111111111111', value: '0x1' }, trustedBlock.number as `0x${string}`] }),
    /zero-value calls/
  )
})
