// ThriveeShield background worker: chain lookups and the activity log.
// It never sees keys and never signs anything. It only reads public chain data.
'use strict';

const NETWORKS = {
  mainnet: { rpc: 'https://rpc.mainnet.fastnear.com', indexer: 'https://api.nearblocks.io' },
  testnet: { rpc: 'https://test.rpc.fastnear.com', indexer: 'https://api-testnet.nearblocks.io' },
};
// Bundled entries are demo names only. A real feed is the on-chain registry (see settings.registry).
const BLOCKED_ACCOUNTS = new Set(['drainer.thrivee-demo.near']);
const BLOCKED_SITES = new Set(['near-mega-airdrop.example']);
const PAGE = 25;
const CACHE_MS = 10 * 60 * 1000;
const MAX_ACTIVITY = 200;
const NO_CODE = '11111111111111111111111111111111';

const cache = new Map();
const networkOf = (id) => (id.endsWith('.testnet') ? 'testnet' : 'mainnet');

async function rpc(network, params) {
  const res = await fetch(NETWORKS[network].rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'thrivee', method: 'query', params: { finality: 'final', ...params } }),
  });
  return res.json();
}

async function viewCall(network, contract, method, args) {
  const body = await rpc(network, { request_type: 'call_function', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  if (!body.result || !body.result.result) throw new Error('view call failed');
  return JSON.parse(String.fromCharCode(...body.result.result));
}

// Oldest transaction on the first page. A full page only proves "at least this old".
async function accountAge(network, id) {
  const res = await fetch(`${NETWORKS[network].indexer}/v3/accounts/${encodeURIComponent(id)}/txns?limit=${PAGE}`);
  if (!res.ok) return {};
  const rows = (await res.json()).data || [];
  if (!rows.length) return {};
  const oldestNs = rows.map((r) => Number(r.block_timestamp)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (!oldestNs) return {};
  return { ageDays: (Date.now() - oldestNs / 1e6) / 86400000, ageAtLeast: rows.length >= PAGE };
}

async function accountInfo(id, registry) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;

  const network = networkOf(id);
  const info = { exists: null, isContract: null, ageDays: null, ageAtLeast: false, blocked: BLOCKED_ACCOUNTS.has(id), reports: 0, codeChanged: false };
  try {
    const body = await rpc(network, { request_type: 'view_account', account_id: id });
    if (body.result) {
      info.exists = true;
      info.isContract = body.result.code_hash !== NO_CODE;
      if (info.isContract) {
        const key = `code:${id}`;
        const saved = (await chrome.storage.local.get(key))[key];
        if (saved && saved !== body.result.code_hash) info.codeChanged = true;
        await chrome.storage.local.set({ [key]: body.result.code_hash });
      }
    } else if (body.error && JSON.stringify(body.error).includes('UNKNOWN_ACCOUNT')) {
      info.exists = false;
    }
  } catch { /* unknown stays null: the guard treats it as "no data", not as safe or unsafe */ }

  if (info.exists) {
    try {
      Object.assign(info, await accountAge(network, id));
    } catch { /* indexer down or rate limited */ }
  }
  if (registry && networkOf(registry) === network) {
    try {
      if (await viewCall(network, registry, 'is_blocked', { account: id })) info.blocked = true;
      else info.reports = (await viewCall(network, registry, 'get_reports', { account: id })).length;
    } catch { /* registry unreachable */ }
  }
  cache.set(id, { at: Date.now(), info });
  return info;
}

async function lookup({ ids, host }) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const list = (ids || []).slice(0, 20).filter((id) => typeof id === 'string' && /^[a-z0-9._-]{2,64}$/.test(id));
  const entries = await Promise.all(list.map(async (id) => [id, await accountInfo(id, settings.registry)]));
  return { info: Object.fromEntries(entries), siteBlocked: BLOCKED_SITES.has(host) };
}

async function record(decision) {
  const { activity = [], sites = {} } = await chrome.storage.local.get(['activity', 'sites']);
  const entry = {
    time: Date.now(),
    host: String(decision.host || '').slice(0, 120),
    wallet: String(decision.wallet || '').slice(0, 40),
    kind: String(decision.kind || ''),
    verdict: ['allow', 'warn', 'block'].includes(decision.verdict) ? decision.verdict : 'warn',
    outcome: String(decision.outcome || '').slice(0, 40),
    action: String((decision.actions && decision.actions[0]) || decision.method || '').slice(0, 200),
    reason: String((decision.findings && decision.findings[0] && decision.findings[0].title) || '').slice(0, 200),
  };
  activity.unshift(entry);
  const site = sites[entry.host] || { firstSeen: entry.time, requests: 0, blocked: 0 };
  site.lastSeen = entry.time;
  site.requests += 1;
  if (entry.verdict === 'block') site.blocked += 1;
  if (entry.kind === 'signIn' && entry.outcome !== 'blocked' && entry.outcome !== 'user cancelled') site.connected = entry.time;
  sites[entry.host] = site;
  await chrome.storage.local.set({ activity: activity.slice(0, MAX_ACTIVITY), sites });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'lookup') {
    lookup(msg.payload || {}).then(sendResponse, () => sendResponse({ info: {}, siteBlocked: false }));
    return true; // async reply
  }
  if (msg.type === 'decision') {
    record(msg.payload || {}).catch(() => {});
    return false;
  }
  return false;
});
