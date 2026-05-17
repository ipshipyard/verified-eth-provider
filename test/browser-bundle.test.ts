import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const debugReferencePattern = /\b(?:process|globalThis\.process)\.env\.DEBUG\b/

test('browser bundling regression: package bundles cleanly when process.env.DEBUG is replaced', async () => {
  const result = await build({
    stdin: {
      contents: "import { createVerifiedTransport } from '@ipshipyard/verified-eth-provider'\nvoid createVerifiedTransport\n",
      loader: 'js',
      resolveDir: repoRoot,
      sourcefile: path.join(repoRoot, 'browser-consumer-entry.js')
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    define: {
      'process.env.DEBUG': 'undefined'
    },
    write: false
  })

  const outputFiles = result.outputFiles ?? []

  assert.equal(result.errors.length, 0)
  assert.ok(outputFiles.length > 0)
  assert.doesNotMatch(outputFiles[0].text, debugReferencePattern)
})
