// Collects the public chain data the account check-up needs. Read-only: RPC views and the
// NearBlocks indexer. No keys, no signing.
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
  try {
    const res = await fetchImpl(`${NETWORKS[network].indexer}/v3/accounts/${encodeURIComponent(accountId)}/txns?limit=${TXN_PAGE}`);
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    txns = ((await res.json()).data || []).map((r) => ({
      counterparty: r.receiver_account_id === accountId ? r.signer_account_id : r.receiver_account_id,
      when: Number(r.block_timestamp) / 1e6,
    })).filter((t) => validAccount(t.counterparty) && t.counterparty !== accountId);
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

  return { accountId, network, account: acc.result, keys, txns, info, partial };
}
