// Small helpers shared by the risk service, the agent wrapper and the scripts.
import { Account, JsonRpcProvider } from 'near-api-js';

export const TGAS_30 = 30_000_000_000_000n;
export const NEAR_YOCTO = 1_000_000_000_000_000_000_000_000n;

export const NETWORKS = {
  testnet: {
    rpcUrl: process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com',
    explorer: 'https://testnet.nearblocks.io/txns/',
    indexer: process.env.INDEXER_URL || 'https://api-testnet.nearblocks.io',
  },
  sandbox: { explorer: null, indexer: null },
};

export const makeProvider = (url) => new JsonRpcProvider({ url });
export const accountFrom = (id, secretKey, provider) => new Account(id, provider, secretKey);

export const toYocto = (near) => {
  const [whole, frac = ''] = String(near).split('.');
  return BigInt(whole) * NEAR_YOCTO + BigInt((frac + '0'.repeat(24)).slice(0, 24));
};
export const fromYocto = (y) => {
  const s = BigInt(y).toString().padStart(25, '0');
  const w = s.slice(0, -24);
  const f = s.slice(-24).replace(/0+$/, '').slice(0, 4);
  return f ? `${w}.${f}` : w;
};

export async function view(provider, contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

/** Sends a function call and returns { value, txHash, logs }. Throws on failure. */
export async function call(account, contractId, methodName, args = {}, { deposit = 0n, gas = TGAS_30 } = {}) {
  const res = await account.callFunctionRaw({ contractId, methodName, args, deposit, gas });
  const status = res.status;
  const sv = status && typeof status === 'object' ? status.SuccessValue : undefined;
  let value = null;
  if (sv) {
    try { value = JSON.parse(Buffer.from(sv, 'base64').toString('utf8')); } catch { value = null; }
  }
  const logs = (res.receipts_outcome || []).flatMap((r) => r.outcome.logs || []);
  return { value, txHash: res.transaction?.hash, logs };
}

/** One readable line for any chain error (contract panic, key permission failure, RPC error). */
export function describeError(err) {
  const bits = [];
  if (err?.panicMessage) bits.push(err.panicMessage);
  if (err?.type) bits.push(err.type);
  if (err?.message && !bits.includes(err.message)) bits.push(err.message);
  const data = err?.data ?? err?.cause?.data;
  if (data && typeof data === 'object') {
    try { bits.push(JSON.stringify(data).slice(0, 300)); } catch { /* ignore */ }
  }
  return bits.filter(Boolean).join(' | ') || String(err);
}

export const explorerLink = (network, txHash) =>
  NETWORKS[network]?.explorer && txHash ? `${NETWORKS[network].explorer}${txHash}` : null;
