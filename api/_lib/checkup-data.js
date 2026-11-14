// Collects the public chain data the account check-up needs. Read-only: RPC views and the
// NearBlocks indexer. No keys, no signing.
import '../../extension/shared/guard-core.js';

const NETWORKS = {
  mainnet: { rpc: 'https://rpc.mainnet.fastnear.com', indexer: 'https://api.nearblocks.io' },
  testnet: { rpc: 'https://test.rpc.fastnear.com', indexer: 'https://api-testnet.nearblocks.io' },
};
// Demo entries only. See the README: there is no real scam feed yet.
const BLOCKED_ACCOUNTS = new Set(['drainer.thrivee-demo.near']);
const MAX_CONTRACTS = 15;
const MAX_COUNTERPARTIES = 10;
const TXN_PAGE = 25;

export function validAccount(id) {
  return typeof id === 'string' && /^(?=.{2,64}$)[a-z0-9]+([._-][a-z0-9]+)*$/.test(id);
}

export function validTxHash(h) {
  return typeof h === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(h);
}

const MIN_DEPOSIT = 10n ** 20n; // 0.0001 NEAR; smaller values are 1-yocto security deposits

function labelFor(actions, direction) {
  if (!Array.isArray(actions) || actions.length === 0) return 'Other action';
  const first = actions[0] && typeof actions[0] === 'object' ? actions[0] : {};
  let base;
  switch (first.action) {
    case 'TRANSFER':
      base = direction === 'out' ? 'Sent NEAR' : 'Received NEAR';
      break;
    case 'FUNCTION_CALL':
      base = typeof first.method === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(first.method)
        ? `Called ${first.method}`
        : 'Called a contract method';
      break;
    case 'ADD_KEY':
      base = 'Added a key';
      break;
    case 'DELETE_KEY':
      base = 'Deleted a key';
      break;
    case 'CREATE_ACCOUNT':
      base = 'Created an account';
      break;
    case 'DEPLOY_CONTRACT':
      base = 'Deployed a contract';
      break;
    case 'DELETE_ACCOUNT':
      base = 'Deleted an account';
      break;
    case 'STAKE':
      base = 'Staked NEAR';
      break;
    default:
      base = 'Other action';
  }
  return actions.length > 1 ? `${base} (+${actions.length - 1} more)` : base;
}

// Turns NearBlocks v3 transaction rows into display-safe items for the check-up report.
export function mapTransactions(rows, accountId) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const hash = row.transaction_hash;
    if (!validTxHash(hash)) continue;
    const ts = row.block_timestamp;
    if (typeof ts !== 'string' || !/^\d+$/.test(ts)) continue;
    const date = new Date(Math.floor(Number(ts) / 1e6));
    if (Number.isNaN(date.getTime())) continue;
    const time = date.toISOString();
    const direction = row.signer_account_id === accountId ? 'out' : 'in';
    const rawParty = direction === 'out' ? row.receiver_account_id : row.signer_account_id;
    const counterparty = rawParty !== accountId && validAccount(rawParty) ? rawParty : null;
    const label = labelFor(row.actions, direction);
    const deposit = row.actions_agg && row.actions_agg.deposit;
    const amount = typeof deposit === 'string' && /^\d+$/.test(deposit) && BigInt(deposit) >= MIN_DEPOSIT
      ? globalThis.ThriveeGuard.fmtNear(deposit)
      : null;
    const success = !(row.outcomes && row.outcomes.status === false);
    const flagged = counterparty !== null && BLOCKED_ACCOUNTS.has(counterparty);
    out.push({ hash, time, direction, counterparty, label, amount, success, flagged });
  }
  out.sort((a, b) => b.time.localeCompare(a.time));
  return out.slice(0, TXN_PAGE);
}

export const networkOf = (id) => (id.endsWith('.testnet') ? 'testnet' : 'mainnet');

async function rpc(fetchImpl, network, params) {
  const res = await fetchImpl(NETWORKS[network].rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'thrivee', method: 'query', params: { finality: 'final', ...params } }),
  });
  return res.json();
}

const isUnknownAccount = (body) => !!body.error && JSON.stringify(body.error).includes('UNKNOWN_ACCOUNT');

// Returns { notFound: true } or the input for ThriveeGuard.auditAccount plus { network, partial }.
export async function collect(accountId, fetchImpl = fetch) {
  const network = networkOf(accountId);
  const partial = [];

  const acc = await rpc(fetchImpl, network, { request_type: 'view_account', account_id: accountId });
  if (isUnknownAccount(acc)) return { notFound: true, network };
  if (!acc.result) throw new Error('the NEAR RPC did not answer');

  const keyBody = await rpc(fetchImpl, network, { request_type: 'view_access_key_list', account_id: accountId });
  const keys = (keyBody.result && keyBody.result.keys) || [];
  if (!keyBody.result) partial.push('access keys');

  let txns = [];
  let transactions = [];
  try {
    const res = await fetchImpl(`${NETWORKS[network].indexer}/v3/accounts/${encodeURIComponent(accountId)}/txns?limit=${TXN_PAGE}`);
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const body = await res.json();
    const rows = Array.isArray(body.data) ? body.data : [];
    txns = rows.map((r) => ({
      counterparty: r.receiver_account_id === accountId ? r.signer_account_id : r.receiver_account_id,
      when: Number(r.block_timestamp) / 1e6,
    })).filter((t) => validAccount(t.counterparty) && t.counterparty !== accountId);
    transactions = mapTransactions(rows, accountId);
  } catch {
    partial.push('recent transactions');
  }

  const contracts = [...new Set(keys
    .map((k) => k.access_key && k.access_key.permission && k.access_key.permission.FunctionCall)
    .filter(Boolean)
    .map((fc) => fc.receiver_id)
    .filter(validAccount))].slice(0, MAX_CONTRACTS);
  const counterparties = [...new Set(txns.map((t) => t.counterparty))].slice(0, MAX_COUNTERPARTIES);

  const info = {};
  await Promise.all(contracts.map(async (id) => {
    const entry = { exists: null, blocked: BLOCKED_ACCOUNTS.has(id) };
    try {
      const body = await rpc(fetchImpl, networkOf(id), { request_type: 'view_account', account_id: id });
      if (body.result) entry.exists = true;
      else if (isUnknownAccount(body)) entry.exists = false;
    } catch { /* stays unknown */ }
    info[id] = entry;
  }));
  for (const id of counterparties) info[id] = { ...(info[id] || {}), blocked: BLOCKED_ACCOUNTS.has(id) };

  return { accountId, network, account: acc.result, keys, txns, transactions, info, partial };
}
