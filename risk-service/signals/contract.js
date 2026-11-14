// Signal 2: is the receiver a contract, and did its code change since we last saw it?
// Uses RPC view_account (code_hash) compared with a saved snapshot.
const NO_CODE = '11111111111111111111111111111111';

export async function contractSignal(receiver, { provider, snapshots }) {
  let acct;
  try {
    acct = await provider.viewAccount({ accountId: receiver });
  } catch (err) {
    if (/does not exist|UNKNOWN_ACCOUNT|UnknownAccount/i.test(`${err?.type} ${err?.message}`)) {
      return { signal: 'contract', level: 'warn', detail: 'receiver account does not exist on chain', data: { exists: false } };
    }
    return { signal: 'contract', level: 'info', detail: `could not read account (${err.message})`, data: null };
  }
  const codeHash = acct.code_hash;
  if (!codeHash || codeHash === NO_CODE) {
    return { signal: 'contract', level: 'ok', detail: 'receiver is a plain account (no contract code)', data: { exists: true, isContract: false } };
  }
  const prev = snapshots.get(receiver);
  if (!prev) {
    snapshots.set(receiver, codeHash);
    return {
      signal: 'contract', level: 'warn',
      detail: 'receiver is a contract seen for the first time, code hash saved as the baseline',
      data: { exists: true, isContract: true, codeHash, firstSeen: true },
    };
  }
  if (prev.codeHash !== codeHash) {
    return {
      signal: 'contract', level: 'block',
      detail: `contract code changed since the saved snapshot (${prev.codeHash.slice(0, 8)}... -> ${codeHash.slice(0, 8)}...)`,
      data: { exists: true, isContract: true, codeHash, previousCodeHash: prev.codeHash, changed: true },
    };
  }
  return { signal: 'contract', level: 'ok', detail: 'receiver is a contract with unchanged code', data: { exists: true, isContract: true, codeHash } };
}
