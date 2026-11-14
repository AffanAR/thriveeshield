import test from 'node:test';
import assert from 'node:assert/strict';
import { mapTransactions, validTxHash } from '../api/_lib/checkup-data.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SAMPLE_HASH = 'Ck3LYWghs8p8wWTT16Ag5C5Zq4iEqbRV2F3Lsb27hgaY';
const makeHash = (i = 0) => `Ck3LYWghs8p8wWTT16Ag5C5Zq4iEqbRV2F3Lsb27hg${BASE58[Math.floor(i / 58)]}${BASE58[i % 58]}`;

function baseRow(overrides = {}) {
  return {
    actions: [{ action: 'FUNCTION_CALL', method: 'ft_transfer_call' }],
    actions_agg: { deposit: '1' },
    block_timestamp: '1794661716684912848',
    outcomes: { status: true },
    receiver_account_id: 'wrap.near',
    signer_account_id: 'alice.near',
    transaction_hash: SAMPLE_HASH,
    ...overrides,
  };
}

test('validTxHash accepts 43- and 44-char base58 strings and rejects invalid inputs', () => {
  assert.equal(validTxHash('1'.repeat(43)), true);
  assert.equal(validTxHash(SAMPLE_HASH), true);
  assert.equal(validTxHash('1'.repeat(42)), false);
  assert.equal(validTxHash('1'.repeat(45)), false);
  assert.equal(validTxHash(12345), false);
  assert.equal(validTxHash(null), false);
  assert.equal(validTxHash(''), false);
});

test('mapTransactions returns [] when rows is not an array', () => {
  assert.deepEqual(mapTransactions(null, 'me.near'), []);
  assert.deepEqual(mapTransactions('x', 'me.near'), []);
});

test('direction out and in, counterparty, ISO time, and exact item shape', () => {
  const outRow = baseRow({
    transaction_hash: makeHash(1),
    signer_account_id: 'alice.near',
    receiver_account_id: 'wrap.near',
    block_timestamp: '1794661716684912848',
  });
  const inRow = baseRow({
    transaction_hash: makeHash(2),
    signer_account_id: 'bob.near',
    receiver_account_id: 'alice.near',
    block_timestamp: '1794661716000000000',
  });

  const res = mapTransactions([inRow, outRow], 'alice.near');
  assert.equal(res.length, 2);
  assert.deepEqual(Object.keys(res[0]).sort(), [
    'amount',
    'counterparty',
    'direction',
    'flagged',
    'hash',
    'label',
    'success',
    'time',
  ]);
  assert.equal(res[0].direction, 'out');
  assert.equal(res[0].counterparty, 'wrap.near');
  assert.equal(res[0].time, new Date(1794661716684).toISOString());
  assert.equal(res[1].direction, 'in');
  assert.equal(res[1].counterparty, 'bob.near');
});

test('labels cover all action types, multi-action suffix, and unsafe method fallback', () => {
  const cases = [
    { actions: [{ action: 'TRANSFER' }], signer: 'alice.near', receiver: 'bob.near', expected: 'Sent NEAR' },
    { actions: [{ action: 'TRANSFER' }], signer: 'bob.near', receiver: 'alice.near', expected: 'Received NEAR' },
    { actions: [{ action: 'FUNCTION_CALL', method: 'ft_transfer_call' }], signer: 'alice.near', receiver: 'wrap.near', expected: 'Called ft_transfer_call' },
    { actions: [{ action: 'FUNCTION_CALL', method: 'a b<script>' }], signer: 'alice.near', receiver: 'wrap.near', expected: 'Called a contract method' },
    { actions: [{ action: 'FUNCTION_CALL', method: '' }], signer: 'alice.near', receiver: 'wrap.near', expected: 'Called a contract method' },
    { actions: [{ action: 'ADD_KEY' }], signer: 'alice.near', receiver: 'alice.near', expected: 'Added a key' },
    { actions: [{ action: 'DELETE_KEY' }], signer: 'alice.near', receiver: 'alice.near', expected: 'Deleted a key' },
    { actions: [{ action: 'CREATE_ACCOUNT' }], signer: 'alice.near', receiver: 'sub.alice.near', expected: 'Created an account' },
    { actions: [{ action: 'DEPLOY_CONTRACT' }], signer: 'alice.near', receiver: 'alice.near', expected: 'Deployed a contract' },
    { actions: [{ action: 'DELETE_ACCOUNT' }], signer: 'alice.near', receiver: 'alice.near', expected: 'Deleted an account' },
    { actions: [{ action: 'STAKE' }], signer: 'alice.near', receiver: 'pool.near', expected: 'Staked NEAR' },
    { actions: [{ action: 'DELEGATE_ACTION' }], signer: 'alice.near', receiver: 'bob.near', expected: 'Other action' },
    { actions: [], signer: 'alice.near', receiver: 'bob.near', expected: 'Other action' },
    { actions: null, signer: 'alice.near', receiver: 'bob.near', expected: 'Other action' },
    {
      actions: [{ action: 'TRANSFER' }, { action: 'ADD_KEY' }, { action: 'FUNCTION_CALL', method: 'init' }],
      signer: 'alice.near',
      receiver: 'bob.near',
      expected: 'Sent NEAR (+2 more)',
    },
  ];

  cases.forEach((c, idx) => {
    const [item] = mapTransactions([
      baseRow({
        transaction_hash: makeHash(idx + 10),
        actions: c.actions,
        signer_account_id: c.signer,
        receiver_account_id: c.receiver,
      }),
    ], 'alice.near');
    assert.equal(item.label, c.expected);
  });
});

test('amount formatting and minimum deposit threshold', () => {
  const checkAmount = (rowOverrides) => {
    const [item] = mapTransactions([baseRow(rowOverrides)], 'alice.near');
    return item.amount;
  };

  assert.equal(checkAmount({ actions_agg: { deposit: '1' } }), null);
  assert.equal(checkAmount({ actions_agg: { deposit: '100000000000000000000' } }), '0.0001 NEAR');
  assert.equal(checkAmount({ actions_agg: { deposit: '5000000000000000000000000' } }), '5 NEAR');
  assert.equal(checkAmount({ actions_agg: { deposit: 'not-a-number' } }), null);
  assert.equal(checkAmount({ actions_agg: undefined }), null);
});

test('outcomes status controls success flag', () => {
  const [failed] = mapTransactions([baseRow({ outcomes: { status: false } })], 'alice.near');
  assert.equal(failed.success, false);

  const [missingOutcomes] = mapTransactions([baseRow({ outcomes: undefined })], 'alice.near');
  assert.equal(missingOutcomes.success, true);

  const [okOutcomes] = mapTransactions([baseRow({ outcomes: { status: true } })], 'alice.near');
  assert.equal(okOutcomes.success, true);
});

test('flagged is true for blocklisted counterparty and false for ordinary accounts', () => {
  const [flaggedItem] = mapTransactions([
    baseRow({ receiver_account_id: 'drainer.thrivee-demo.near' }),
  ], 'alice.near');
  assert.equal(flaggedItem.flagged, true);

  const [normalItem] = mapTransactions([
    baseRow({ receiver_account_id: 'wrap.near' }),
  ], 'alice.near');
  assert.equal(normalItem.flagged, false);
});

test('invalid counterparty and self-transactions set counterparty to null', () => {
  const [badParty] = mapTransactions([
    baseRow({ receiver_account_id: 'Not Valid!' }),
  ], 'alice.near');
  assert.equal(badParty.counterparty, null);
  assert.equal(badParty.flagged, false);

  const [selfTx] = mapTransactions([
    baseRow({ signer_account_id: 'alice.near', receiver_account_id: 'alice.near' }),
  ], 'alice.near');
  assert.equal(selfTx.direction, 'out');
  assert.equal(selfTx.counterparty, null);
  assert.equal(selfTx.flagged, false);
});

test('skips malformed rows, invalid hashes, and non-digit timestamps', () => {
  const badRows = [
    null,
    'not-an-object',
    baseRow({ transaction_hash: undefined }),
    baseRow({ transaction_hash: '1'.repeat(42) }),
    baseRow({ transaction_hash: '0' + '1'.repeat(43) }),
    baseRow({ transaction_hash: 'O' + '1'.repeat(43) }),
    baseRow({ transaction_hash: 'I' + '1'.repeat(43) }),
    baseRow({ transaction_hash: 'l' + '1'.repeat(43) }),
    baseRow({ transaction_hash: '/' + '1'.repeat(43) }),
    baseRow({ block_timestamp: '179466171668491284a' }),
    baseRow({ block_timestamp: '' }),
    baseRow({ block_timestamp: 1794661716684912848 }),
    baseRow({ block_timestamp: '9'.repeat(30) }),
  ];

  assert.deepEqual(mapTransactions(badRows, 'alice.near'), []);
});

test('sorts newest first and caps output at 25 items', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push(baseRow({
      transaction_hash: makeHash(i),
      block_timestamp: String(1700000000000000000n + BigInt(i) * 1000000000n),
    }));
  }

  const out = mapTransactions(rows, 'alice.near');
  assert.equal(out.length, 25);
  assert.equal(out[0].hash, makeHash(29));
  assert.equal(out[24].hash, makeHash(5));
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].time >= out[i].time);
  }
});
