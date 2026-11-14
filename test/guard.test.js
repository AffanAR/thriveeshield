import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../extension/shared/guard-core.js';
import { SHARED } from '../scripts/sync-demo.js';

test('the web demo runs the same guard files as the extension', () => {
  for (const [from, to] of SHARED) {
    const a = fs.readFileSync(new URL(`../${from}`, import.meta.url), 'utf8');
    const b = fs.readFileSync(new URL(`../${to}`, import.meta.url), 'utf8');
    assert.equal(b, a, `${to} is out of date: run "npm run demo:sync"`);
  }
});

const G = globalThis.ThriveeGuard;
const NEAR = (n) => (BigInt(Math.round(n * 1000)) * 10n ** 21n).toString();
const known = { exists: true, isContract: true, ageDays: 400 };
const person = { exists: true, isContract: false, ageDays: 400 };

function run(method, arg, info = {}, extra = {}) {
  const req = G.normalizeRequest(method, [arg]);
  return { req, res: G.evaluate(req, { origin: 'example.org', info, ...extra }) };
}

test('full-access AddKey on your own account is blocked', () => {
  const { res } = run('signAndSendTransaction', {
    receiverId: 'me.near',
    actions: [{ type: 'AddKey', params: { publicKey: 'ed25519:abc', accessKey: { permission: 'FullAccess' } } }],
  }, { 'me.near': person });
  assert.equal(res.verdict, 'block');
  assert.match(res.findings[0].title, /whole account/);
});

test('near-api-js shaped full-access AddKey is also blocked', () => {
  const { res } = run('signAndSendTransaction', {
    receiverId: 'me.near',
    actions: [{ addKey: { publicKey: 'ed25519:abc', accessKey: { nonce: 0, permission: { fullAccess: {} } } } }],
  }, { 'me.near': person });
  assert.equal(res.verdict, 'block');
});

test('AddKey inside a create-account batch is not blocked', () => {
  const { res } = run('signAndSendTransaction', {
    receiverId: 'sub.me.near',
    actions: [
      { type: 'CreateAccount', params: {} },
      { type: 'Transfer', params: { deposit: NEAR(1) } },
      { type: 'AddKey', params: { publicKey: 'ed25519:abc', accessKey: { permission: 'FullAccess' } } },
    ],
  }, { 'sub.me.near': { exists: true, ageDays: 400 } });
  assert.notEqual(res.verdict, 'block');
});

test('limited AddKey warns and names the contract', () => {
  const { res } = run('signAndSendTransaction', {
    receiverId: 'me.near',
    actions: [{ type: 'AddKey', params: { publicKey: 'ed25519:abc', accessKey: { permission: { receiverId: 'app.near', methodNames: ['play'], allowance: '1' } } } }],
  }, { 'me.near': person });
  assert.equal(res.verdict, 'warn');
  assert.ok(res.findings.some((f) => /play on app\.near/.test(f.detail)));
});

test('DeleteAccount and DeployContract are blocked', () => {
  const del = run('signAndSendTransaction', { receiverId: 'me.near', actions: [{ type: 'DeleteAccount', params: { beneficiaryId: 'thief.near' } }] }, { 'me.near': person, 'thief.near': person });
  assert.equal(del.res.verdict, 'block');
  assert.deepEqual(G.accountsToLookup(del.req).sort(), ['me.near', 'thief.near']);
  const dep = run('signAndSendTransaction', { receiverId: 'me.near', actions: [{ type: 'DeployContract', params: { code: new Uint8Array(3) } }] }, { 'me.near': person });
  assert.equal(dep.res.verdict, 'block');
});

test('small transfer to an old account is allowed', () => {
  const { res } = run('signAndSendTransaction', { receiverId: 'friend.near', actions: [{ type: 'Transfer', params: { deposit: NEAR(1) } }] }, { 'friend.near': person });
  assert.equal(res.verdict, 'allow');
  assert.equal(res.actions[0], 'Send 1 NEAR to friend.near');
});

test('transfer to a blocklisted account is blocked', () => {
  const { res } = run('signAndSendTransaction', { receiverId: 'scam.near', actions: [{ type: 'Transfer', params: { deposit: NEAR(1) } }] }, { 'scam.near': { ...person, blocked: true } });
  assert.equal(res.verdict, 'block');
});

test('transfer to a new account, a missing account or a large amount warns', () => {
  const young = run('signAndSendTransaction', { receiverId: 'new.near', actions: [{ type: 'Transfer', params: { deposit: NEAR(1) } }] }, { 'new.near': { exists: true, ageDays: 2 } });
  assert.equal(young.res.verdict, 'warn');
  const missing = run('signAndSendTransaction', { receiverId: 'typo.near', actions: [{ type: 'Transfer', params: { deposit: NEAR(1) } }] }, { 'typo.near': { exists: false } });
  assert.equal(missing.res.verdict, 'warn');
  const large = run('signAndSendTransaction', { receiverId: 'friend.near', actions: [{ type: 'Transfer', params: { deposit: NEAR(25) } }] }, { 'friend.near': person });
  assert.equal(large.res.verdict, 'warn');
});

test('an "at least this old" age never counts as new', () => {
  const { res } = run('signAndSendTransaction', { receiverId: 'busy.near', actions: [{ type: 'Transfer', params: { deposit: NEAR(1) } }] }, { 'busy.near': { exists: true, ageDays: 1, ageAtLeast: true } });
  assert.equal(res.verdict, 'allow');
});

test('a brand-new implicit address is only a note', () => {
  const id = 'a'.repeat(64);
  const { res } = run('sendMoney', { receiverId: id, amount: NEAR(1) }, { [id]: { exists: false } });
  assert.equal(res.verdict, 'allow');
});

test('ft_transfer checks the token receiver, not just the token contract', () => {
  const tx = { receiverId: 'usdt.near', actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer', args: { receiver_id: 'scam.near', amount: '5' }, deposit: '1' } }] };
  const { req, res } = run('signAndSendTransaction', tx, { 'usdt.near': known, 'scam.near': { ...person, blocked: true } });
  assert.deepEqual(G.accountsToLookup(req).sort(), ['scam.near', 'usdt.near']);
  assert.equal(res.verdict, 'block');
});

test('function call args as bytes or JSON text are read', () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ receiver_id: 'scam.near' }));
  const a = G.normalizeAction({ functionCall: { methodName: 'ft_transfer', args: bytes, deposit: 1n } });
  assert.equal(a.args.receiver_id, 'scam.near');
  const b = G.normalizeAction({ methodName: 'ft_transfer', args: '{"receiver_id":"x.near"}' });
  assert.equal(b.kind, 'FunctionCall');
  assert.equal(b.args.receiver_id, 'x.near');
});

test('nft_approve warns', () => {
  const { res } = run('signAndSendTransaction', { receiverId: 'nft.near', actions: [{ type: 'FunctionCall', params: { methodName: 'nft_approve', args: { token_id: '1', account_id: 'market.near' }, deposit: '1' } }] }, { 'nft.near': known, 'market.near': known });
  assert.equal(res.verdict, 'warn');
});

test('ordinary contract call is allowed', () => {
  const { res } = run('signAndSendTransaction', { receiverId: 'dex.near', actions: [{ type: 'FunctionCall', params: { methodName: 'swap', args: {}, deposit: NEAR(1) } }] }, { 'dex.near': known });
  assert.equal(res.verdict, 'allow');
});

test('batch: one bad transaction blocks the whole request', () => {
  const { res } = run('requestSignTransactions', {
    transactions: [
      { receiverId: 'dex.near', actions: [{ type: 'FunctionCall', params: { methodName: 'swap', args: {} } }] },
      { receiverId: 'me.near', actions: [{ type: 'AddKey', params: { publicKey: 'ed25519:x', accessKey: { permission: 'FullAccess' } } }] },
    ],
  }, { 'dex.near': known, 'me.near': person });
  assert.equal(res.verdict, 'block');
  assert.equal(res.actions.length, 2);
});

test('encoded transaction warns', () => {
  const { res } = run('requestSignTransactions', { transactions: [new Uint8Array([1, 2, 3])] });
  assert.equal(res.verdict, 'warn');
});

test('sign-in: plain is allowed, new contract warns, blocklisted contract is blocked', () => {
  assert.equal(run('requestSignIn', { contractId: 'app.near', methodNames: [] }, { 'app.near': known }).res.verdict, 'allow');
  assert.equal(run('requestSignIn', { contractId: 'app.near' }, { 'app.near': { exists: true, ageDays: 1 } }).res.verdict, 'warn');
  assert.equal(run('requestSignIn', 'bad.near', { 'bad.near': { exists: true, blocked: true } }).res.verdict, 'block');
  assert.equal(run('requestSignIn', {}).res.verdict, 'allow');
});

test('message signing is allowed, a blocklisted site blocks everything', () => {
  assert.equal(run('signMessage', { message: 'hi', recipient: 'app.near' }).res.verdict, 'allow');
  assert.equal(run('signMessage', { message: 'hi' }, {}, { siteBlocked: true }).res.verdict, 'block');
});

test('unknown wallet method warns', () => {
  assert.equal(run('batchImport', {}).res.verdict, 'warn');
});

test('audit: one full-access key and live app keys scores Good', () => {
  const r = G.auditAccount({
    accountId: 'me.near',
    account: { code_hash: '11111111111111111111111111111111' },
    keys: [
      { public_key: 'ed25519:a', access_key: { permission: 'FullAccess' } },
      { public_key: 'ed25519:b', access_key: { permission: { FunctionCall: { receiver_id: 'app.near', method_names: [], allowance: '1' } } } },
    ],
    txns: [{ counterparty: 'app.near' }],
    info: { 'app.near': known },
  });
  assert.equal(r.grade, 'Good');
  assert.equal(r.keys.full, 1);
  assert.equal(r.keys.limited, 1);
});

test('audit: extra full-access keys, dead app, blocklisted app and own contract lower the score', () => {
  const fc = (c) => ({ public_key: 'ed25519:' + c, access_key: { permission: { FunctionCall: { receiver_id: c, method_names: [], allowance: null } } } });
  const r = G.auditAccount({
    accountId: 'me.near',
    account: { code_hash: 'Abc' },
    keys: [
      { public_key: 'ed25519:a', access_key: { permission: 'FullAccess' } },
      { public_key: 'ed25519:b', access_key: { permission: 'FullAccess' } },
      fc('gone.near'),
      fc('bad.near'),
    ],
    txns: [{ counterparty: 'bad.near' }],
    info: { 'gone.near': { exists: false }, 'bad.near': { exists: true, blocked: true } },
  });
  assert.equal(r.grade, 'At risk');
  assert.equal(r.findings[0].level, 'block');
  assert.ok(r.findings.some((f) => /2 full-access keys/.test(f.title)));
  assert.ok(r.findings.some((f) => /gone\.near/.test(f.title)));
  assert.ok(r.findings.some((f) => /contract is installed/.test(f.title)));
});
