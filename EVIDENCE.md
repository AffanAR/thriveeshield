# Evidence

## What was run

| Check | Command | Result |
|---|---|---|
| Contract unit tests | `npm run contract:test` (cargo test, Rust 1.100, near-sdk 5.30.1) | 29 passed, 0 failed |
| Risk service unit tests | `npm test` | 11 passed, 0 failed |
| End-to-end attack demo on a local NEAR sandbox (2.14.0) | `node agent/demo.js` in `node:24-trixie` | `RESULT: all 24 checks passed`, exit 0 |

- Full demo output: [`evidence/demo-sandbox.log`](evidence/demo-sandbox.log)
- Visual report of the same run: [`evidence/demo-sandbox-report.html`](evidence/demo-sandbox-report.html)
- Screenshots: [`evidence/screenshots/`](evidence/screenshots/)

The log includes the on-chain permission of the agent key:

```text
{"FunctionCall":{"allowance":"250000000000000000000000","method_names":["request_payment","report_address"],"receiver_id":"shield-vault.sandbox"}}
```

![Report](evidence/screenshots/report-overview.png)

![Terminal, scenarios 4 and 5](evidence/screenshots/terminal-scenarios-4-5-extra.png)

The two terminal screenshots are the demo log rendered as a page and captured with headless Chrome. They are not photos of a live terminal window.

## What is not here

- **No testnet transaction hashes.** The demo ran on a local sandbox, so transaction hashes in the log are sandbox hashes and have no explorer link. The testnet path (`scripts/setup.js --network testnet`, `npm run demo:testnet`) was not run in the hackathon window. See the README "Limitations".
- The age signal was exercised against fake indexer responses in unit tests, and its URL and response shape were checked by hand against the live NearBlocks v3 testnet API. It is `unknown` in the sandbox because a local chain has no indexer.
