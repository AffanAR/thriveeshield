import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReceiver } from '../risk-service/engine.js';
import { ageSignal } from '../risk-service/signals/age.js';
import { contractSignal } from '../risk-service/signals/contract.js';
import { Snapshots } from '../risk-service/snapshots.js';

const NO_CODE = '11111111111111111111111111111111';

/** A fake vault + chain. Override fields per test. */
function fakeDeps(o = {}) {
  const snapshots = new Snapshots(null);
  const views = {
    preview_payment: o.preview || { verdict: 'ALLOW', reason: 'ok' },
    policy: { allowlist: o.allowlist || ['friend.test'] },
    is_blocked: o.blocked || false,
    get_reports: o.reports || [],
    receiver_stats: { paid_count: o.paid || 0 },
  };
  return {
    vaultId: 'vault.test',
    indexer: o.indexer ?? null,
    snapshots,
    provider: {
      viewAccount: async () => {
        if (o.missing) throw Object.assign(new Error('account does not exist'), { type: 'AccountDoesNotExist' });
        return { code_hash: o.codeHash || NO_CODE };
      },
    },
    view: async (m) => views[m],
  };
}

test('allowlisted plain account with history is allowed', async () => {
  const r = await checkReceiver({ receiver: 'friend.test', amount: '1' }, fakeDeps({ paid: 3 }));
  assert.equal(r.verdict, 'allow');
});

test('unknown receiver is a warn (the vault preview says WARN)', async () => {
  const r = await checkReceiver({ receiver: 'new.test', amount: '1' }, fakeDeps({ preview: { verdict: 'WARN', reason: 'not on the allowlist' } }));
  assert.equal(r.verdict, 'warn');
});

test('confirmed blocklist entry is a block, with the evidence in the reasons', async () => {
  const reports = [{ reporter: 'watcher.test', evidence: 'drained a vault' }];
  const r = await checkReceiver({ receiver: 'scam.test', amount: '1' }, fakeDeps({ blocked: true, reports, preview: { verdict: 'BLOCK', reason: 'blocklist' } }));
  assert.equal(r.verdict, 'block');
  const bl = r.reasons.find((x) => x.signal === 'blocklist');
  assert.equal(bl.data.reports[0].evidence, 'drained a vault');
});

test('an unconfirmed report only raises warn', async () => {
  const reports = [{ reporter: 'watcher.test', evidence: 'suspicious' }];
  const r = await checkReceiver({ receiver: 'friend.test', amount: '1' }, fakeDeps({ reports }));
  assert.equal(r.verdict, 'warn');
});

test('a vault-policy BLOCK (over limit) cannot be softened by good signals', async () => {
  const r = await checkReceiver({ receiver: 'friend.test', amount: '999' }, fakeDeps({ paid: 9, preview: { verdict: 'BLOCK', reason: 'over limit' } }));
  assert.equal(r.verdict, 'block');
});

test('a receiver account that does not exist is a warn', async () => {
  const r = await checkReceiver({ receiver: 'ghost.test', amount: '1' }, fakeDeps({ missing: true }));
  assert.equal(r.verdict, 'warn');
});

test('contract receiver: first sight warns, same code is ok, changed code blocks', async () => {
  const snapshots = new Snapshots(null);
  const at = (hash) => ({ provider: { viewAccount: async () => ({ code_hash: hash }) }, snapshots });
  assert.equal((await contractSignal('dex.test', at('AAAA1111'))).level, 'warn');
  assert.equal((await contractSignal('dex.test', at('AAAA1111'))).level, 'ok');
  const changed = await contractSignal('dex.test', at('BBBB2222'));
  assert.equal(changed.level, 'block');
  assert.equal(changed.data.changed, true);
});

const ns = (ms) => String(BigInt(ms) * 1_000_000n);
// NearBlocks v3 shape: newest first, { data: [{ block_timestamp }], meta }.
const indexerReturning = (oldestMs, count) => async () => ({
  ok: true,
  json: async () => ({
    data: Array.from({ length: Math.min(count, 25) }, (_, i) => ({ block_timestamp: ns(i === 0 ? oldestMs : NOW) })),
    meta: { next_page: count > 25 ? 'cursor' : null },
  }),
});
const NOW = Date.UTC(2026, 10, 14);
const DAY = 86_400_000;

test('age signal: new account warns, old busy account is ok, thin history warns', async () => {
  const run = (firstMs, count) => ageSignal('a.test', { indexer: 'http://x', now: NOW, fetchImpl: indexerReturning(firstMs, count) });
  assert.equal((await run(NOW - 2 * DAY, 3)).level, 'warn'); // brand new
  assert.equal((await run(NOW - 2 * DAY, 50)).level, 'warn'); // 25+ txns in 2 days: age unconfirmed
  assert.equal((await run(NOW - 400 * DAY, 500)).level, 'ok'); // busy and old
  assert.equal((await run(NOW - 400 * DAY, 2)).level, 'warn'); // old but only 2 txns
});

test('age signal: no indexer or an indexer outage never escalates', async () => {
  assert.equal((await ageSignal('a.test', { indexer: null })).level, 'info');
  const down = async () => { throw new Error('boom'); };
  assert.equal((await ageSignal('a.test', { indexer: 'http://x', fetchImpl: down })).level, 'info');
});

test('age signal: an account with no history warns', async () => {
  const none = async () => ({ ok: true, json: async () => ({ data: [], meta: {} }) });
  assert.equal((await ageSignal('a.test', { indexer: 'http://x', fetchImpl: none })).level, 'warn');
});

test('thin age history on an allowlisted receiver does not escalate', async () => {
  const deps = fakeDeps({ indexer: 'http://x', paid: 1 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = indexerReturning(NOW - 1 * DAY, 3);
  try {
    const r = await checkReceiver({ receiver: 'friend.test', amount: '1' }, deps);
    assert.equal(r.verdict, 'allow');
  } finally {
    globalThis.fetch = realFetch;
  }
});
