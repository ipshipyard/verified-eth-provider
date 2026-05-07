# @ipshipyard/verified-eth-provider

> A [viem](https://viem.sh) transport that pins Ethereum JSON-RPC reads to a caller-supplied trusted block and verifies state proofs locally before returning results.

An honest-but-wrong or dishonest RPC cannot corrupt a verified result.

Built to enable verifiable ENS resolution by [Helia](https://github.com/ipfs/helia) and particularly the IPFS [Service Worker Gateway](https://github.com/ipfs/service-worker-gateway) but generally reusable.

If you have use cases for verified Ethereum reads in other contexts, please open an issue or PR to discuss!

## How it works

The caller supplies a trusted block — either a concrete value or an async provider that fetches one. Every request is pinned to that block number. For verified methods, account proofs, storage proofs, and contract code returned by the RPC are checked locally against the trusted block's `stateRoot` before results are returned. `eth_call` is executed entirely locally against the verified state snapshot.

A bundled helper can be used to derive the trusted block from a primary RPC plus two witness RPCs: all three must agree on the same block hash before it is accepted.

# License

Licensed under either of

- Apache 2.0 ([LICENSE.md](./LICENSE.md) / <https://www.apache.org/licenses/LICENSE-2.0>)
- MIT (<https://opensource.org/licenses/MIT>)

# Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
