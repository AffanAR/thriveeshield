// Request shapes of the message and popup based wallets, built with near-api-js so the
// decoder is checked against an independent encoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, actions, createTransaction, encodeTransaction } from 'near-api-js';
import '../extension/shared/guard-core.js';

const G = globalThis.ThriveeGuard;
const key = KeyPair.fromRandom('ed25519').getPublicKey();
const NEAR = 10n ** 24n;
const old = { exists: true, isContract: false, ageDays: 400 };

function encoded(receiverId, acts) {
  const tx = createTransaction('me.near', key, receiverId, 7n, acts, new Uint8Array(32));
  return { tx, bytes: encodeTransaction(tx), b64: Buffer.from(encodeTransaction(tx)).toString('base64') };
}

test('borsh: transfer and function call are decoded', () => {
  const { bytes } = encoded('usdt.near', [
    actions.transfer(3n * NEAR),
    actions.functionCall('ft_transfer', { receiver_id: 'bob.near', amount: '5' }, 30000000000000n, 1n),
  ]);
  const tx = G.decodeBorshTx(bytes);
  assert.equal(tx.signerId, 'me.near');
  assert.equal(tx.receiverId, 'usdt.near');
  assert.deepEqual(tx.actions[0], { kind: 'Transfer', deposit: (3n * NEAR).toString() });
  assert.equal(tx.actions[1].method, 'ft_transfer');
  assert.equal(tx.actions[1].args.receiver_id, 'bob.near');
  assert.equal(tx.actions[1].deposit, '1');
});

test('borsh: full-access and limited AddKey, DeleteKey, DeleteAccount, DeployContract', () => {
  const { bytes } = encoded('me.near', [
    actions.addFullAccessKey(key),
    actions.addFunctionCallAccessKey(key, 'app.near', ['play', 'stop'], 5n * NEAR),
    actions.deleteKey(key),
    actions.deployContract(new Uint8Array([0, 97, 115, 109])),
    actions.deleteAccount('thief.near'),
  ]);
  const kinds = G.decodeBorshTx(bytes).actions;
  assert.equal(kinds[0].kind, 'AddKey');
  assert.equal(kinds[0].fullAccess, true);
  assert.equal(kinds[1].fullAccess, false);
  assert.equal(kinds[1].receiverId, 'app.near');
  assert.deepEqual(kinds[1].methodNames, ['play', 'stop']);
  assert.equal(kinds[1].allowance, (5n * NEAR).toString());
  assert.equal(kinds[2].kind, 'DeleteKey');
  assert.equal(kinds[3].kind, 'DeployContract');
  assert.deepEqual(kinds[4], { kind: 'DeleteAccount', beneficiary: 'thief.near' });
});

test('borsh: garbage is rejected and becomes an "encoded" warning', () => {
  assert.throws(() => G.decodeBorshTx(new Uint8Array([1, 2, 3])));
  const req = G.normalizeRequest('requestSignTransactions', [{ transactions: ['not base64 at all!'] }]);
  assert.equal(G.evaluate(req, {}).verdict, 'warn');
});

test('Meteor: comma-joined base64 transactions in a message are read and a drain is blocked', () => {
  const safe = encoded('friend.near', [actions.transfer(NEAR)]).b64;
  const drain = encoded('me.near', [actions.addFullAccessKey(key)]).b64;
  const msg = { uid: 'x', status: 'attempting_reconnect', actionType: 'sign', inputs: { transactions: `${safe},${drain}` }, network: 'mainnet' };
  const found = G.extractTransactions(msg);
  assert.equal(found.request.transactions.length, 2);
  assert.deepEqual(G.accountsToLookup(found.request).sort(), ['friend.near', 'me.near']);
  const res = G.evaluate(found.request, { info: { 'friend.near': old, 'me.near': old } });
  assert.equal(res.verdict, 'block');
  assert.equal(found.key, msg.inputs.transactions);
});

test('Meteor: a safe encoded transfer is allowed', () => {
  const found = G.extractTransactions({ inputs: { transactions: encoded('friend.near', [actions.transfer(NEAR)]).b64 } });
  assert.equal(G.evaluate(found.request, { info: { 'friend.near': old } }).verdict, 'allow');
});

test('Intear: JSON-string transactions in a popup message are read', () => {
  const txs = [{ signerId: 'me.near', receiverId: 'scam.near', actions: [{ type: 'Transfer', params: { deposit: NEAR.toString() } }] }];
  const found = G.extractTransactions({ type: 'signAndSendTransactions', data: { transactions: JSON.stringify(txs), accountId: 'me.near', nonce: 1 } });
  assert.equal(found.request.transactions[0].receiverId, 'scam.near');
  assert.equal(G.evaluate(found.request, { info: { 'scam.near': { ...old, blocked: true } } }).verdict, 'block');
});

test('messages without transactions pass untouched', () => {
  assert.equal(G.extractTransactions({ type: 'ready' }), null);
  assert.equal(G.extractTransactions({ type: 'signIn', data: { contractId: 'app.near' } }), null);
  assert.equal(G.extractTransactions('hello'), null);
  assert.equal(G.extractTransactions({ inputs: { transactions: '' } }), null);
});

test('HOT: request payload as an array or as { transactions } is read', () => {
  const tx = { signerId: 'me.near', receiverId: 'me.near', actions: [{ type: 'AddKey', params: { publicKey: 'ed25519:x', accessKey: { permission: 'FullAccess' } } }] };
  for (const payload of [[tx], { transactions: [tx] }]) {
    const req = G.normalizeRequest('near:signAndSendTransactions', [payload]);
    assert.equal(G.evaluate(req, { info: { 'me.near': old } }).verdict, 'block');
  }
  assert.equal(G.normalizeRequest('near:signMessage', [{ message: 'hi' }]).kind, 'message');
});

test('Nightly: a near-api-js Transaction object is read', () => {
  const { tx } = encoded('me.near', [actions.addFullAccessKey(key)]);
  const req = G.normalizeRequest('signTransaction', [tx]);
  assert.equal(req.transactions[0].receiverId, 'me.near');
  assert.equal(G.evaluate(req, { info: { 'me.near': old } }).verdict, 'block');
  const pay = encoded('friend.near', [actions.transfer(2n * NEAR)]).tx;
  const res = G.evaluate(G.normalizeRequest('signTransaction', [pay]), { info: { 'friend.near': old } });
  assert.equal(res.verdict, 'allow');
  assert.equal(res.actions[0], 'Send 2 NEAR to friend.near');
});
