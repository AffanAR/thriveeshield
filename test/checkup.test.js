import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { checkup, explain, findKey } from '../api/checkup.js';
import { validAccount } from '../api/_lib/checkup-data.js';

const NO_CODE = '11111111111111111111111111111111';
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

// A fake chain: me.near has 2 full-access keys, one key for a live app and one for a dead app.
function fakeFetch(calls = []) {
  return async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('openrouter.ai')) {
      const sent = JSON.parse(init.body);
      return json({ choices: [{ message: { content: `AI summary for ${JSON.parse(sent.messages[1].content).account}` } }], _sent: sent });
    }
    if (String(url).includes('nearblocks')) {
      return json({ data: [
        {
          receiver_account_id: 'app.near',
          signer_account_id: 'me.near',
          block_timestamp: '1794000000000000000',
          transaction_hash: 'Ck3LYWghs8p8wWTT16Ag5C5Zq4iEqbRV2F3Lsb27hgaY',
          actions: [{ action: 'FUNCTION_CALL', method: 'play' }],
          actions_agg: { deposit: '1' },
          outcomes: { status: true },
        },
        {
          receiver_account_id: 'me.near',
          signer_account_id: 'friend.near',
          block_timestamp: '1793000000000000000',
          transaction_hash: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
          actions: [{ action: 'TRANSFER' }],
          actions_agg: { deposit: '2000000000000000000000000' },
          outcomes: { status: true },
        },
      ] });
    }
    const p = JSON.parse(init.body).params;
    if (p.request_type === 'view_access_key_list') {
      return json({ result: { keys: [
        { public_key: 'ed25519:a', access_key: { permission: 'FullAccess' } },
        { public_key: 'ed25519:b', access_key: { permission: 'FullAccess' } },
        { public_key: 'ed25519:c', access_key: { permission: { FunctionCall: { receiver_id: 'app.near', method_names: [], allowance: '1' } } } },
        { public_key: 'ed25519:d', access_key: { permission: { FunctionCall: { receiver_id: 'gone.near', method_names: [], allowance: null } } } },
      ] } });
    }
    if (p.account_id === 'gone.near' || p.account_id === 'nobody.near') return json({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } });
    return json({ result: { amount: '5000000000000000000000000', code_hash: NO_CODE } });
  };
}

function fakeRes() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } };
}

test('account names are validated', () => {
  assert.ok(validAccount('alice.near'));
  assert.ok(validAccount('a'.repeat(64)));
  for (const bad of ['', 'A.near', 'a', 'has space.near', '../etc', 'x'.repeat(65), '.near', 'a..near', 'ignore previous instructions']) {
    assert.equal(validAccount(bad), false, bad);
  }
});

test('check-up scores the account and attaches the AI summary', async () => {
  const calls = [];
  const r = await checkup('me.near', { fetchImpl: fakeFetch(calls), env: { OPENROUTER_API_KEY: 'test-key' } });
  assert.equal(r.balance, '5 NEAR');
  assert.equal(r.keys.full, 2);
  assert.equal(r.keys.limited, 2);
  assert.ok(r.findings.some((f) => /2 full-access keys/.test(f.title)));
  assert.ok(r.findings.some((f) => /gone\.near/.test(f.title)));
  assert.equal(r.keys.apps.find((a) => a.contract === 'gone.near').exists, false);
  assert.equal(r.transactionsChecked, 2);
  assert.equal(r.transactions.length, 2);
  assert.equal(r.transactions[0].direction, 'out');
  assert.equal(r.transactions[0].counterparty, 'app.near');
  assert.equal(r.transactions[0].label, 'Called play');
  assert.equal(r.transactions[1].direction, 'in');
  assert.equal(r.transactions[1].counterparty, 'friend.near');
  assert.equal(r.transactions[1].label, 'Received NEAR');
  assert.equal(r.transactions[1].amount, '2 NEAR');
  assert.equal(r.ai, 'AI summary for me.near');
  assert.equal(r.aiModel, 'anthropic/claude-haiku-5.5');
  assert.ok(r.score < 100);
});

test('when the indexer answers not-ok, transactions is empty and partial includes recent transactions', async () => {
  const fetchImpl = async (url, init) => (String(url).includes('nearblocks') ? json({}, false, 500) : fakeFetch()(url, init));
  const r = await checkup('me.near', { fetchImpl, env: {} });
  assert.deepEqual(r.transactions, []);
  assert.equal(r.transactionsChecked, 0);
  assert.ok(r.partial.includes('recent transactions'));
});

test('the OpenRouter request body never contains a transaction hash', async () => {
  let sentBody = '';
  const fetchImpl = async (url, init) => {
    if (String(url).includes('openrouter.ai')) sentBody = String(init.body);
    return fakeFetch()(url, init);
  };
  await checkup('me.near', { fetchImpl, env: { OPENROUTER_API_KEY: 'k' } });
  assert.ok(sentBody.length > 0);
  assert.ok(!sentBody.includes('Ck3LYWghs8p8wWTT16Ag5C5Zq4iEqbRV2F3Lsb27hgaY'));
  assert.ok(!sentBody.includes('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'));
});

test('without an API key the rule-based report still comes back', async () => {
  const calls = [];
  const r = await checkup('me.near', { fetchImpl: fakeFetch(calls), env: {} });
  assert.equal(r.ai, null);
  assert.match(r.aiNote, /no API key/);
  assert.ok(r.findings.length > 0);
  assert.ok(!calls.some((u) => u.includes('openrouter')));
});

test('an AI failure does not break the report, and the key is never echoed', async () => {
  const failing = async (url, init) => (String(url).includes('openrouter') ? json({}, false, 500) : fakeFetch()(url, init));
  const r = await checkup('me.near', { fetchImpl: failing, env: { OPENROUTER_API_KEY: 'secret-key-value' } });
  assert.equal(r.ai, null);
  assert.match(r.aiNote, /500/);
  assert.ok(!JSON.stringify(r).includes('secret-key-value'));
});

test('the model only receives the audit facts, with the chosen model and a token cap', async () => {
  let sent;
  const spy = async (url, init) => {
    sent = { url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) };
    return json({ choices: [{ message: { content: 'ok' } }] });
  };
  const report = { accountId: 'me.near', score: 76, grade: 'Needs attention', keys: { full: 2, limited: 0 }, findings: [{ level: 'warn', title: 't', detail: 'd' }] };
  const out = await explain(report, { fetchImpl: spy, env: { OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'some/other-model' } });
  assert.equal(out.text, 'ok');
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.auth, 'Bearer k');
  assert.equal(sent.body.model, 'some/other-model');
  assert.equal(sent.body.max_tokens, 1500);
  assert.deepEqual(Object.keys(JSON.parse(sent.body.messages[1].content)).sort(), ['account', 'appKeys', 'findings', 'fullAccessKeys', 'grade', 'score']);
});

test('an answer cut off by the token limit keeps only whole sentences', async () => {
  const report = { accountId: 'me.near', score: 88, grade: 'Good', keys: { full: 2, limited: 0 }, findings: [] };
  const reply = (content, finish_reason) => async () => json({ choices: [{ message: { content }, finish_reason }] });
  const env = { OPENROUTER_API_KEY: 'k' };
  const cut = await explain(report, { env, fetchImpl: reply('This account scores 88 out of 100, which is Good. It has two keys. You should rem', 'length') });
  assert.equal(cut.text, 'This account scores 88 out of 100, which is Good. It has two keys.');
  const whole = await explain(report, { env, fetchImpl: reply('All fine. Nothing to do', 'stop') });
  assert.equal(whole.text, 'All fine. Nothing to do');
  const tiny = await explain(report, { env, fetchImpl: reply('This account', 'length') });
  assert.equal(tiny.text, null);
  assert.match(tiny.reason, /cut off/);
});

test('key lookup tolerates naming slips and reports names, never values', () => {
  assert.equal(findKey({ OPENROUTER_API_KEY: '  abc  ' }).key, 'abc');
  assert.equal(findKey({ OPENROUTER_KEY: 'abc' }).key, 'abc');
  assert.equal(findKey({ 'OpenRouter_Api_Key ': 'abc' }).key, 'abc');
  assert.equal(findKey({ OPENROUTER_MODEL: 'some/model' }).key, null);
  assert.match(findKey({}).reason, /sees: none/);
  const empty = findKey({ OPENROUTER_API_KEY: '   ' });
  assert.equal(empty.key, null);
  assert.match(empty.reason, /"OPENROUTER_API_KEY" \(empty\)/);
  const odd = findKey({ OPENROUTER_SECRET: 'super-secret-value' });
  assert.equal(odd.key, null);
  assert.match(odd.reason, /"OPENROUTER_SECRET"/);
  assert.ok(!odd.reason.includes('super-secret-value'));
});

test('a missing account is reported as not found', async () => {
  const r = await checkup('nobody.near', { fetchImpl: fakeFetch(), env: {} });
  assert.equal(r.notFound, true);
});

test('handler rejects bad input before touching the network', async () => {
  for (const [url, method, status] of [
    ['/api/checkup?account=NOT%20VALID', 'GET', 400],
    ['/api/checkup', 'GET', 400],
    ['/api/checkup?account=me.near', 'POST', 405],
  ]) {
    const res = fakeRes();
    await handler({ method, url, headers: {} }, res);
    assert.equal(res.statusCode, status, url);
    assert.ok(res.body.error);
  }
});
