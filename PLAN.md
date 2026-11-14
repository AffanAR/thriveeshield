# Implementation Plan: Recent transactions in the account check-up

Written by the `ecc:planner` agent on 2026-11-14. Implementation is delegated to Antigravity (`agy`); Claude reviews and runs the gates.

## Overview

The indexer rows are already fetched in `collect()`, but each row is cut down to `{ counterparty, when }` and the API only returns a count. This plan adds a pure, validated mapper that turns NearBlocks v3 rows into display-safe `transactions`. It returns them from `/api/checkup` next to the existing `transactionsChecked`, and renders them in a new "Recent transactions" panel. `extension/`, `docs/shared/`, `vercel.json` and the `explain()` prompt stay unchanged.

## Design decisions (fixed for all tasks)

- The mapper lives in `api/_lib/checkup-data.js` as exported `mapTransactions(rows, accountId)` and `validTxHash(h)`. This module already owns `validAccount` and `BLOCKED_ACCOUNTS`. For `fmtNear` it adds `import '../../extension/shared/guard-core.js';` and reads `globalThis.ThriveeGuard.fmtNear`. That is a side-effect import that `api/checkup.js` already does, so guard-core is not modified.
- Output item shape: `{ hash, time, direction, counterparty, label, amount, success, flagged }`.
  - `hash`: must match `/^[1-9A-HJ-NP-Za-km-z]{43,44}$/` (base58). Otherwise the row is skipped.
  - `time`: `block_timestamp` must be a digit string. `new Date(Math.floor(Number(ts) / 1e6)).toISOString()`. Otherwise the row is skipped.
  - `direction`: `'out'` if `signer_account_id === accountId`, else `'in'`.
  - `counterparty`: for `out` it is the receiver, for `in` the signer. It is `null` if it equals `accountId` or fails `validAccount()`.
  - `label`, from the first action, plus ` (+N more)` when there are several actions:
    - TRANSFER: "Sent NEAR" (out) or "Received NEAR" (in)
    - FUNCTION_CALL: `Called <method>`, only when the method matches `/^[A-Za-z0-9_]{1,64}$/`, else "Called a contract method"
    - ADD_KEY: "Added a key"
    - DELETE_KEY: "Deleted a key"
    - CREATE_ACCOUNT: "Created an account"
    - DEPLOY_CONTRACT: "Deployed a contract"
    - DELETE_ACCOUNT: "Deleted an account"
    - STAKE: "Staked NEAR"
    - Missing or unknown action: "Other action"
  - `amount`: `fmtNear(deposit)` when `actions_agg.deposit` is a digit string and `BigInt(deposit) >= 10n ** 20n` (0.0001 NEAR). Otherwise `null`.
  - `success`: `!(outcomes && outcomes.status === false)`. A row is marked failed only when the indexer explicitly says so.
  - `flagged`: `BLOCKED_ACCOUNTS.has(counterparty)`. This is checked directly, not through `info`, because `info` covers only 10 counterparties.
  - Rows that are not objects are skipped. The result is sorted by `time` descending and sliced to 25.
- Self-transactions (for example adding a key to your own account) ARE included in `transactions` with `counterparty: null`. The existing `txns` filter and `transactionsChecked` stay exactly as they are.
- The API returns only `hash`. The page builds the explorer URL itself (`https://nearblocks.io/txns/` or `https://testnet.nearblocks.io/txns/` from `r.network`) after checking the hash against the same regex again.

## Tasks

- [x] 1. Add the pure transaction mapper and its unit tests
  - Files: `api/_lib/checkup-data.js` (add the import, `validTxHash` and `mapTransactions`; do not touch `collect()`), new `test/checkup-transactions.test.js`.
  - Acceptance criteria:
    - `mapTransactions` and `validTxHash` are exported and follow the design rules above exactly. Neither makes a network call.
    - Tests cover:
      - direction out and in
      - each of the labels above, including the `(+N more)` suffix and an unsafe method name such as `"a b<script>"` falling back to "Called a contract method"
      - the amount threshold: `"1"` gives null, `"100000000000000000000"` gives `"0.0001 NEAR"`, `"5000000000000000000000000"` gives `"5 NEAR"`, a non-digit deposit gives null
      - `outcomes.status: false` gives `success: false`
      - a counterparty of `drainer.thrivee-demo.near` gives `flagged: true`
      - skipped rows: missing hash, a 42-char hash, a hash with `0`/`O`/`I`/`l`, a hash containing `/`, a non-digit timestamp, `null` and a string row
      - an invalid counterparty becomes `null`
      - sorting is newest first and the cap is 25 (feed 30 rows)
      - the ISO time is correct for the sample `1794661716684912848`
    - `npm test` passes: all 51 existing tests plus the new ones.
  - Leave alone: `collect()`, `api/checkup.js`, `docs/`, `extension/`, existing tests.

- [x] 2. Return `transactions` from the API
  - Files: `api/_lib/checkup-data.js` (`collect()` only), `api/checkup.js` (`checkup()` return object only), `test/checkup.test.js`.
  - Acceptance criteria:
    - `collect()` parses the indexer body once. It keeps the existing `txns` mapping and filter byte-for-byte in behaviour and adds `transactions: mapTransactions(rows, accountId)` to its return value. On indexer failure, `transactions` is `[]` and `partial` still gets `'recent transactions'`. A non-array `data` is treated as `[]`.
    - `checkup()` adds `transactions: data.transactions` and keeps `transactionsChecked: data.txns.length`.
    - `explain()` and its `facts` object are unchanged. The existing test that asserts the exact `facts` keys still passes, and a new assertion checks that the OpenRouter request body does not contain any fake transaction hash.
    - In `test/checkup.test.js`, the fake nearblocks rows gain valid 44-char base58 `transaction_hash`, `actions`, `actions_agg` and `outcomes`. New assertions:
      - `r.transactions.length === 2`
      - `r.transactions[0].direction === 'out'` (newest first)
      - `r.transactions[1].direction === 'in'` with counterparty `friend.near`
      - `transactionsChecked` is still 2
    - A new test where the indexer answers `ok: false` checks that `transactions` is `[]` and `partial` includes `'recent transactions'`.
    - `npm test` passes.
  - Leave alone: `explain()`, `findKey()`, the handler, the cache and rate limiting, `extension/`, `docs/shared/`, `vercel.json`.

- [x] 3. Render the "Recent transactions" panel
  - Files: `docs/checkup.html` only (CSS block, markup, inline script).
  - Acceptance criteria:
    - A new `.panel` with `<h2>Recent transactions</h2>` sits after the "Keys on this account" panel. It contains `<ul class="txs" id="txs">` and `<div class="ai-note" id="tx-note">`.
    - Each `li` is a flex row with `flex-wrap:wrap` and `min-width:0`, not a table, so a phone-width screen never scrolls horizontally. Long values use `overflow-wrap:anywhere`. Each row shows:
      - a direction pill: "Out" (`p-warn`) or "In" (`p-na`)
      - the label
      - the amount when it is not null
      - the counterparty in monospace, or "this account" when it is null
      - a short time: "5 min ago", "3 h ago", "2 d ago", otherwise a `toLocaleDateString()` date, with the full ISO time in `title`
      - a `p-bad` "failed" pill when `success === false`
      - a `p-bad` "blocklisted" pill when `flagged`
      - a "View" link with `target="_blank"` and `rel="noopener noreferrer"`. The link is created only when the hash passes `/^[1-9A-HJ-NP-Za-km-z]{43,44}$/` and the network is `mainnet` or `testnet`.
    - All text is set with `textContent` or the existing `el()` helper, and `href` is set with `a.href = ...`. No `innerHTML`, `insertAdjacentHTML` or `outerHTML` is added anywhere (a grep of the diff confirms this).
    - `r.transactions || []` guards against an older API response. When `partial` includes `'recent transactions'`, the note reads "Recent transactions could not be read from the indexer right now." Otherwise, when the list is empty, it reads "No recent transactions on this account." Otherwise the note is empty.
    - The `k-tx` counter still shows `transactionsChecked`.
    - `npm test` passes, including the sync-demo copy test, because `docs/shared/` is untouched.
  - Leave alone: the score, AI, findings and keys rendering logic, the `API` origin logic, the footer, every other file.

## Testing strategy

- Unit tests (task 1): the pure mapper, run with `npm test`.
- Integration tests (task 2): `checkup()` with the fake fetch, covering the success path, the indexer failure path, and a check that the AI prompt has no transaction data.
- Manual check (task 3, run by Claude): `node scripts/dev-server.js`, then check one mainnet and one testnet account, a 360 px wide viewport, and a fake response with a bad hash so no link appears.

## Risks / open questions

- Success semantics: rows with a missing `outcomes` show as successful. The alternative is `success: null` with no marker, but the requested contract says boolean.
- NearBlocks may return one row per receipt or several rows with the same `transaction_hash`. If live data shows duplicates, dedupe by hash in a follow-up. The plan does not dedupe, so `transactionsChecked` keeps its meaning.
- Including self-transactions in `transactions` means the list length can differ from `transactionsChecked`. That is intended, and it surfaces "Added a key" events on your own account, but it may look inconsistent to a reader.
- Importing guard-core from `checkup-data.js` relies on the global side effect. The order is safe because `api/checkup.js` already imports guard-core first, and the import is idempotent.
- The response cache is in memory and resets per deploy, so old cached bodies without `transactions` are unlikely. The `|| []` guard covers it anyway.
- Tests for the rendering in task 3 are manual only. The repo has no DOM test harness, and adding one would bring in a dependency.
