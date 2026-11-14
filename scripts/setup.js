// Creates the owner and vault accounts, deploys the vault contract, initialises its policy and
// gives the agent a function-call key scoped to ONE contract (the vault) and TWO methods.
//
//   node scripts/setup.js --network testnet     (needs NEAR_FUNDER_ID + NEAR_FUNDER_KEY, a testnet account with ~15 NEAR)
//
// The demo (agent/demo.js) calls deployVault() itself against a local sandbox, so it needs no secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair } from 'near-api-js';
import { accountFrom, call, makeProvider, NETWORKS, toYocto } from '../lib/chain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WASM_PATH = path.join(here, '..', 'contract', 'res', 'thriveeshield_vault.wasm');
export const AGENT_METHODS = ['request_payment', 'report_address'];

/** Gas allowance of the agent key. When it runs out the key stops working. See README. */
export const AGENT_ALLOWANCE_NEAR = '0.25';

export async function deployVault({ rpcUrl, funderId, funderKey, prefix = 'shield', log = () => {} }) {
  const provider = makeProvider(rpcUrl);
  const funder = accountFrom(funderId, funderKey, provider);
  const ownerKp = KeyPair.fromRandom('ed25519');
  const adminKp = KeyPair.fromRandom('ed25519');
  const agentKp = KeyPair.fromRandom('ed25519');
  const ownerId = `${prefix}-owner.${funderId}`;
  const vaultId = `${prefix}-vault.${funderId}`;
  const txs = {};

  log(`creating owner account ${ownerId}`);
  txs.createOwner = (await funder.createAccount({ newAccountId: ownerId, publicKey: ownerKp.getPublicKey(), nearToTransfer: toYocto('2') })).transaction?.hash;

  log(`creating vault account ${vaultId}`);
  txs.createVault = (await funder.createAccount({ newAccountId: vaultId, publicKey: adminKp.getPublicKey(), nearToTransfer: toYocto('10') })).transaction?.hash;

  log('deploying the vault contract');
  const vaultAdmin = accountFrom(vaultId, adminKp.toString(), provider);
  txs.deploy = (await vaultAdmin.deployContract(fs.readFileSync(WASM_PATH))).transaction?.hash;

  log('initialising the vault policy (per-tx 2 NEAR, daily 5 NEAR)');
  txs.init = (await call(vaultAdmin, vaultId, 'new', {
    owner: ownerId,
    per_tx_limit: toYocto('2').toString(),
    daily_limit: toYocto('5').toString(),
  })).txHash;

  log('adding the agent function-call key (vault only, request_payment + report_address)');
  txs.addAgentKey = (await vaultAdmin.addFunctionCallAccessKey({
    publicKey: agentKp.getPublicKey(),
    contractId: vaultId,
    methodNames: AGENT_METHODS,
    allowance: toYocto(AGENT_ALLOWANCE_NEAR),
  })).transaction?.hash;

  return {
    rpcUrl, funderId, vaultId, ownerId,
    ownerKey: ownerKp.toString(),
    // Offline recovery key for the vault account. The agent process never loads it.
    vaultAdminKey: adminKp.toString(),
    agentKey: agentKp.toString(),
    agentPublicKey: agentKp.getPublicKey().toString(),
    txs,
  };
}

/** Plain accounts the demo pays or reports: friend (allowlisted), stranger, scam, watcher (another agent). */
export async function createDemoAccounts({ rpcUrl, funderId, funderKey, prefix = 'shield' }) {
  const provider = makeProvider(rpcUrl);
  const funder = accountFrom(funderId, funderKey, provider);
  const out = {};
  for (const name of ['friend', 'stranger', 'scam', 'watcher']) {
    const kp = KeyPair.fromRandom('ed25519');
    const id = `${prefix}-${name}.${funderId}`;
    await funder.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: toYocto('1') });
    out[name] = { id, key: kp.toString() };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--network');
  const network = i > -1 ? process.argv[i + 1] : 'testnet';
  if (network !== 'testnet') {
    console.error('Only --network testnet is supported here. The default demo uses a local sandbox: npm run demo');
    process.exit(1);
  }
  const { NEAR_FUNDER_ID, NEAR_FUNDER_KEY } = process.env;
  if (!NEAR_FUNDER_ID || !NEAR_FUNDER_KEY) {
    console.error('Set NEAR_FUNDER_ID and NEAR_FUNDER_KEY (a testnet account, see README). They are only used to create the demo accounts.');
    process.exit(1);
  }
  const rpcUrl = process.env.NEAR_RPC_URL || NETWORKS.testnet.rpcUrl;
  const state = await deployVault({ rpcUrl, funderId: NEAR_FUNDER_ID, funderKey: NEAR_FUNDER_KEY, log: (m) => console.log(`- ${m}`) });
  console.log('- creating demo receiver accounts');
  state.demo = await createDemoAccounts({ rpcUrl, funderId: NEAR_FUNDER_ID, funderKey: NEAR_FUNDER_KEY });
  const dir = path.join(here, '..', '.state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'testnet.json'), JSON.stringify({ network, ...state }, null, 2), { mode: 0o600 });
  console.log(`\nvault: ${state.vaultId}\nowner: ${state.ownerId}\nstate saved to .state/testnet.json (keep it private)`);
}
