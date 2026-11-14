// Combines the four signals and the vault's own preview verdict into allow / warn / block.
// The service is advisory: signals can only make a verdict stricter than the contract's preview.
// The contract still decides on-chain, so a compromised agent cannot skip it.
import { ageSignal } from './signals/age.js';
import { contractSignal } from './signals/contract.js';
import { historySignal } from './signals/history.js';
import { blocklistSignal } from './signals/blocklist.js';

const RANK = { allow: 0, warn: 1, block: 2 };
const FROM_LEVEL = { ok: 'allow', info: 'allow', warn: 'warn', block: 'block' };

export async function checkReceiver({ receiver, amount }, deps) {
  const { provider, vaultId, snapshots, indexer, view } = deps;
  const preview = await view('preview_payment', { receiver, amount: String(amount) });
  const allowlisted = (await view('policy', {})).allowlist.includes(receiver);

  const signals = await Promise.all([
    blocklistSignal(receiver, { view }),
    historySignal(receiver, { view }),
    contractSignal(receiver, { provider, snapshots }),
    ageSignal(receiver, { indexer }),
  ]);

  const reasons = [{
    signal: 'vault-policy',
    level: { ALLOW: 'ok', WARN: 'warn', BLOCK: 'block' }[preview.verdict],
    detail: `vault policy preview: ${preview.verdict} (${preview.reason})`,
  }];
  for (const s of signals) {
    // An allowlisted receiver was chosen by the owner, so a thin history alone does not escalate it.
    // Reports, the blocklist and changed contract code always escalate.
    const softAge = s.signal === 'age' && allowlisted && s.level === 'warn';
    reasons.push(softAge ? { ...s, level: 'info', detail: `${s.detail} (ignored: receiver is allowlisted)` } : s);
  }

  let verdict = 'allow';
  for (const r of reasons) {
    const v = FROM_LEVEL[r.level] || 'allow';
    if (RANK[v] > RANK[verdict]) verdict = v;
  }
  return { verdict, receiver, amount: String(amount), vault: vaultId, reasons };
}
