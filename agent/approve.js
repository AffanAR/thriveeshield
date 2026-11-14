// The human side. Uses the OWNER key, which the agent never holds.
//   node agent/approve.js list
//   node agent/approve.js approve <id>
//   node agent/approve.js reject <id>
//   node agent/approve.js confirm-report <account>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountFrom, call, fromYocto, makeProvider, view } from '../lib/chain.js';

export async function listPending(provider, vaultId) {
  return view(provider, vaultId, 'get_pending');
}

export const approvePending = (owner, vaultId, id) => call(owner, vaultId, 'approve_pending', { id });
export const rejectPending = (owner, vaultId, id) => call(owner, vaultId, 'reject_pending', { id });
export const confirmReport = (owner, vaultId, target) => call(owner, vaultId, 'confirm_report', { target });

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const network = process.env.NETWORK || 'testnet';
  const stateFile = path.join(here, '..', '.state', `${network}.json`);
  if (!fs.existsSync(stateFile)) {
    console.error(`No ${stateFile}. Run: node scripts/setup.js --network ${network}`);
    process.exit(1);
  }
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const provider = makeProvider(s.rpcUrl);
  const owner = accountFrom(s.ownerId, s.ownerKey, provider);
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'list') {
    const pending = await listPending(provider, s.vaultId);
    if (!pending.length) console.log('no pending payments');
    for (const p of pending) console.log(`#${p.id}  ${fromYocto(p.amount)} NEAR -> ${p.receiver}  (${p.reason})`);
  } else if (cmd === 'approve') {
    const r = await approvePending(owner, s.vaultId, Number(arg));
    console.log('outcome:', r.value, 'tx', r.txHash);
  } else if (cmd === 'reject') {
    const r = await rejectPending(owner, s.vaultId, Number(arg));
    console.log('rejected, tx', r.txHash);
  } else if (cmd === 'confirm-report') {
    const r = await confirmReport(owner, s.vaultId, arg);
    console.log('block confirmed, tx', r.txHash);
  } else {
    console.error('usage: approve.js list | approve <id> | reject <id> | confirm-report <account>');
    process.exit(1);
  }
}
