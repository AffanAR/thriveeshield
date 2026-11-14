// Signal 1: account age and activity, from the NearBlocks v3 API (GET /v3/accounts/{id}/txns).
// v3 lists newest first and has no public count, so we read one page (PAGE transactions):
//   - fewer than PAGE transactions: we see the whole history, so age and count are exact;
//   - a full page: the account has at least PAGE transactions, and the oldest one on the page
//     is a lower bound for its age.
// If no indexer is configured (local sandbox) the signal reports "unknown" and never escalates.
const DAY_MS = 86_400_000;
export const MIN_AGE_DAYS = 7;
export const MIN_TXNS = 5;
export const PAGE = 25;

export async function ageSignal(receiver, { indexer, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!indexer) {
    return { signal: 'age', level: 'info', detail: 'no indexer configured, account age unknown', data: null };
  }
  try {
    const r = await fetchImpl(`${indexer}/v3/accounts/${receiver}/txns?limit=${PAGE}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`indexer HTTP ${r.status}`);
    const body = await r.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    if (rows.length === 0) {
      return { signal: 'age', level: 'warn', detail: 'no transaction history found for this account', data: { txns: 0 } };
    }
    const oldestMs = Math.min(...rows.map((t) => Number(BigInt(t.block_timestamp) / 1_000_000n)));
    const ageDays = Math.floor((now - oldestMs) / DAY_MS);
    const full = rows.length >= PAGE || Boolean(body?.meta?.next_page);
    const data = { ageDays, txns: rows.length, atLeast: full };
    const count = full ? `${PAGE}+` : String(rows.length);
    if (ageDays < MIN_AGE_DAYS) {
      return {
        signal: 'age', level: 'warn', data,
        detail: full ? `${count} transactions within the last ${ageDays} day(s), age cannot be confirmed` : `account is only ${ageDays} day(s) old`,
      };
    }
    if (!full && rows.length < MIN_TXNS) {
      return { signal: 'age', level: 'warn', detail: `account has only ${rows.length} transaction(s)`, data };
    }
    return { signal: 'age', level: 'ok', detail: `account is ${full ? 'at least ' : ''}${ageDays} days old with ${count} transactions`, data };
  } catch (err) {
    return { signal: 'age', level: 'info', detail: `indexer unavailable (${err.message}), account age unknown`, data: null };
  }
}
