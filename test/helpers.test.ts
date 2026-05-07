import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertBlockFreshness,
  ensureHexAddress,
  ensureHexData,
  isRetryableLocalExecutionError,
  mergeAccessLists,
  pinRpcMethodToBlock
} from '../src/helpers.ts'

test('pinRpcMethodToBlock pins block-sensitive methods', () => {
  const blockNumber = '0x123'

  assert.deepEqual(
    pinRpcMethodToBlock('eth_getCode', ['0xabc'], blockNumber),
    ['0xabc', blockNumber]
  )
  assert.deepEqual(
    pinRpcMethodToBlock('eth_getStorageAt', ['0xabc', '0x01'], blockNumber),
    ['0xabc', '0x01', blockNumber]
  )
  assert.deepEqual(
    pinRpcMethodToBlock('eth_getBlockByNumber', ['latest'], blockNumber),
    [blockNumber, false]
  )
})

test('pinRpcMethodToBlock keeps state override for eth_call', () => {
  const tx = { to: '0x1111111111111111111111111111111111111111', data: '0x' }
  const override = { some: 'override' }

  assert.deepEqual(
    pinRpcMethodToBlock('eth_call', [tx, 'latest', override], '0x100'),
    [tx, '0x100', override]
  )
})

test('mergeAccessLists merges and de-duplicates storage keys', () => {
  const merged = mergeAccessLists(
    {
      accessList: [
        { address: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa', storageKeys: ['0x1'] }
      ]
    },
    {
      accessList: [
        { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', storageKeys: ['0x1', '0x2'] },
        { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', storageKeys: [] }
      ]
    }
  )

  assert.equal(merged.accessList.length, 2)
  const first = merged.accessList.find(entry => entry.address === '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.ok(first)
  assert.deepEqual([...first.storageKeys].sort(), ['0x1', '0x2'])
})

test('ensureHexAddress normalizes lowercase and rejects invalid values', () => {
  assert.equal(
    ensureHexAddress('0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa', 'addr'),
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )

  assert.throws(
    () => ensureHexAddress('not-an-address', 'addr'),
    /Invalid addr address/
  )
})

test('ensureHexData validates hex payloads', () => {
  assert.equal(ensureHexData('0x1234', 'data'), '0x1234')
  assert.throws(() => ensureHexData('1234', 'data'), /Invalid data hex data/)
})

test('isRetryableLocalExecutionError recognizes proof/state errors', () => {
  assert.equal(isRetryableLocalExecutionError(new Error('missing trie node')), true)
  assert.equal(isRetryableLocalExecutionError(new Error('execution reverted')), false)
})

test('assertBlockFreshness rejects stale block timestamps', () => {
  const freshBlock = {
    number: '0x10',
    hash: '0x01',
    stateRoot: '0x02',
    timestamp: '0x64'
  }

  assert.doesNotThrow(() => assertBlockFreshness(freshBlock, 5_000, 100_000))
  assert.throws(
    () => assertBlockFreshness(freshBlock, 1_000, 103_000),
    /timestamp is/
  )
})