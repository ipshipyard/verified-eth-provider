import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertBlockFreshness,
  ensureHexAddress,
  ensureHexData,
  ensureHexQuantity,
  isRetryableLocalExecutionError,
  mergeAccessLists
} from '../src/helpers.ts'

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
  assert.equal(ensureHexData('0xABCD', 'data'), '0xabcd')
  assert.throws(() => ensureHexData('1234', 'data'), /Invalid data hex data/)
  assert.throws(() => ensureHexData('0x123', 'data'), /Invalid data hex data/)
  assert.throws(() => ensureHexData('0xzz', 'data'), /Invalid data hex data/)
})

test('ensureHexQuantity validates canonical hex quantities', () => {
  assert.equal(ensureHexQuantity('0x1C', 'value'), '0x1c')
  assert.throws(() => ensureHexQuantity('0x01', 'value'), /Invalid value hex quantity/)
  assert.throws(() => ensureHexQuantity('0xzz', 'value'), /Invalid value hex quantity/)
})

test('isRetryableLocalExecutionError recognizes proof/state errors', () => {
  assert.equal(isRetryableLocalExecutionError(new Error('Missing node in DB')), true)
  assert.equal(isRetryableLocalExecutionError(new Error('execution reverted')), false)
})

test('assertBlockFreshness rejects stale block timestamps', () => {
  const freshBlock = {
    number: '0x10',
    hash: `0x${'01'.repeat(32)}`,
    stateRoot: `0x${'02'.repeat(32)}`,
    timestamp: '0x64',
    gasLimit: '0x1c9c380',
    miner: '0x0000000000000000000000000000000000000000',
    mixHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
  }

  assert.doesNotThrow(() => assertBlockFreshness(freshBlock, 5_000, 100_000))
  assert.throws(
    () => assertBlockFreshness(freshBlock, 1_000, 103_000),
    /is 3s old/
  )

  assert.throws(
    () => assertBlockFreshness(freshBlock, 1_000, 97_000),
    /in the future/
  )
})