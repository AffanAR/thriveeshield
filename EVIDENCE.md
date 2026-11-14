# Evidence

## What was run

| Check | Command | Result |
|---|---|---|
| Contract unit tests | `npm run contract:test` (cargo test, Rust 1.100, near-sdk 5.30.1) | 23 passed, 0 failed |
| Risk service unit tests | `npm test` | 11 passed, 0 failed |
| End-to-end attack demo on a local NEAR sandbox (2.14.0) | `node agent/demo.js` in `node:24-trixie` | `RESULT: all 18 checks passed`, exit 0 |
| Same demo from a clean copy of the repo (no `node_modules`, no state) | README Docker command | `npm ci`, 11 node tests passed, `RESULT: all 18 checks passed` |

The full demo output is in [`evidence/demo-sandbox.log`](evidence/demo-sandbox.log). It includes the on-chain permission of the agent key:

```text
{"FunctionCall":{"allowance":"250000000000000000000000","method_names":["request_payment","report_address"],"receiver_id":"shield-vault.sandbox"}}
```

## What is not here

- **No testnet transaction hashes.** The demo ran on a local sandbox, so transaction hashes in the log are sandbox hashes and have no explorer link. The testnet path (`scripts/setup.js --network testnet`, `npm run demo:testnet`) was not run in the hackathon window. See the README "Limitations".
- The age signal was exercised against fake indexer responses in unit tests, and its URL and response shape were checked by hand against the live NearBlocks v3 testnet API. It is `unknown` in the sandbox because a local chain has no indexer.
