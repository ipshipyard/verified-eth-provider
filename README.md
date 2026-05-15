# @ipshipyard/verified-eth-provider

> A [viem](https://viem.sh) transport for read-only Ethereum mainnet calls that pins JSON-RPC reads to a caller-supplied trusted block and verifies state proofs locally before returning results.

For supported read-only calls, an honest-but-wrong or dishonest RPC cannot corrupt a verified result.

Built to enable verifiable ENS resolution by [Helia](https://github.com/ipfs/helia) and particularly the IPFS [Service Worker Gateway](https://github.com/ipfs/service-worker-gateway). The current scope is Ethereum mainnet, post-merge, read-only usage.

If you have use cases for verified Ethereum reads in other contexts, please open an issue or PR to discuss!

## How it works

The caller supplies a trusted block — either a concrete value or an async provider that fetches one. Every request is pinned to that block number. For verified methods, account proofs, storage proofs, and contract code returned by the RPC are checked locally against the trusted block's `stateRoot` before results are returned. `eth_call` is executed locally against the verified state snapshot using trusted block context for `NUMBER`, `TIMESTAMP`, `BASEFEE`, `GASLIMIT`, `COINBASE`, and `PREVRANDAO`.

A bundled helper can be used to derive the trusted block from a primary RPC plus two witness RPCs: all three must agree on the same trusted block fields (`number`, `hash`, `timestamp`, `stateRoot`, `baseFeePerGas`, `gasLimit`, `miner`, and `mixHash`) before it is accepted.

## API

### `createVerifiedTransport(config, options?)`

Returns a `VerifiedTransport` — a standard `viem` `Transport` with two extra fields:

- `trustedBlock` — the `TrustedBlock` captured at creation time
- `prewarmVerificationDependencies()` — eagerly loads the proof-verification dependencies (otherwise lazy on first use)

### `createQuorumTrustedBlockSelector(config, options?)`

Returns a `TrustedBlockProvider` suitable for passing as `config.trustedBlock`. On each call it:

1. Fetches the `safe` block from the primary RPC.
2. Confirms the same trusted block fields (`number`, `hash`, `timestamp`, `stateRoot`, `baseFeePerGas`, `gasLimit`, `miner`, and `mixHash`) from both witness RPCs.
3. Rejects the block if it is older than `maxSafeBlockAgeMs`.

Notes:

- No `eth_chainId` checks are performed by the selector. You must configure all endpoints for Ethereum mainnet. Quorum catches endpoint disagreement, not unanimous wrong-chain configuration.
- The selector returns a canonical `TrustedBlock` shape and discards extra RPC fields.

## Request handling

All requests are pinned to the trusted block number. Only the following read-only methods are accepted; all others throw.

| Method | Handling |
|---|---|
| `eth_getCode` | The RPC response is verified: an account proof is fetched and checked against the trusted `stateRoot`, then the returned code is checked against the `codeHash` in that proof. |
| `eth_call` | Only zero-value calls are supported. An access list is obtained via `eth_createAccessList`, account/storage proofs and code for all accessed addresses are fetched and verified, then the call is executed locally against that verified state snapshot. Retried up to three times if the access list proves incomplete. State overrides are not supported. Calls that execute `BLOBBASEFEE` fail. |

**Block tag normalization:** callers that do not specify a block number — including viem (which defaults to `"latest"`) and post-merge tooling that uses `"safe"` or `"finalized"` — are automatically pinned to the trusted block number. The tags `"latest"`, `"safe"`, and `"finalized"` are treated as aliases for the trusted block; any other explicit block parameter that does not match the trusted block number is rejected.

## Example

```ts
import { createPublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import {
  createQuorumTrustedBlockSelector,
  createVerifiedTransport
} from '@ipshipyard/verified-eth-provider'

const trustedBlockProvider = createQuorumTrustedBlockSelector({
  primaryRpc: 'https://primary.example',
  witnessRpcs: ['https://witness-a.example', 'https://witness-b.example'],
  maxSafeBlockAgeMs: 60_000
})

const transport = await createVerifiedTransport({
  rpcUrl: 'https://primary.example',
  trustedBlock: trustedBlockProvider
})

void transport.prewarmVerificationDependencies()

const client = createPublicClient({ chain: mainnet, transport })
```

## Development

```bash
npm test
npm run typecheck
```

# License

Licensed under either of

- Apache 2.0 ([LICENSE.md](./LICENSE.md) / <https://www.apache.org/licenses/LICENSE-2.0>)
- MIT (<https://opensource.org/licenses/MIT>)

# Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
