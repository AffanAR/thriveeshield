// Web demo for ThriveeShield.
// Everything on this page is simulated: the "scam site", the wallet and the account data.
// Only the guard itself (shared/guard-core.js + shared/inject.js) is the real extension code.
(function () {
  'use strict';

  const YOU = 'you.thrivee-demo.near';
  const NEAR = (n) => (BigInt(Math.round(n * 1000)) * 10n ** 21n).toString();
  let shieldOn = true;

  // Canned account facts, standing in for the chain lookups the extension makes.
  const FACTS = {
    [YOU]: { exists: true, isContract: false, ageDays: 620 },
    'airdrop.thrivee-demo.near': { exists: true, isContract: true, ageDays: 480 },
    'dex.thrivee-demo.near': { exists: true, isContract: true, ageDays: 900 },
    'usdt.thrivee-demo.near': { exists: true, isContract: true, ageDays: 1100 },
    'nft.thrivee-demo.near': { exists: true, isContract: true, ageDays: 700 },
    'new-creator.thrivee-demo.near': { exists: true, isContract: false, ageDays: 2 },
    'market.thrivee-demo.near': { exists: true, isContract: true, ageDays: 300 },
    'drainer.thrivee-demo.near': { exists: true, isContract: false, ageDays: 3, blocked: true, reports: 4 },
  };

  // ---- simulated wallet -------------------------------------------------
  function walletConfirm(method, payload) {
    return new Promise((resolve, reject) => {
      const dlg = document.getElementById('wallet');
      document.getElementById('wallet-method').textContent = method;
      document.getElementById('wallet-raw').textContent = JSON.stringify(payload, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
      const ok = document.getElementById('wallet-ok');
      const no = document.getElementById('wallet-no');
      const close = (fn) => () => {
        ok.onclick = no.onclick = null;
        dlg.close();
        fn();
      };
      ok.onclick = close(() => resolve({ simulated: true, method }));
      no.onclick = close(() => reject(new Error('Rejected in the wallet')));
      dlg.showModal();
    });
  }

  const demoWallet = {
    getAccountId: () => YOU,
    isSignedIn: () => true,
    requestSignIn: (a) => walletConfirm('requestSignIn', a),
    signAndSendTransaction: (a) => walletConfirm('signAndSendTransaction', a),
    requestSignTransactions: (a) => walletConfirm('requestSignTransactions', a),
    signMessage: (a) => walletConfirm('signMessage', a),
  };
  window.demoWallet = demoWallet;

  window.__THRIVEE_DEMO__ = {
    isEnabled: () => shieldOn,
    lookup: async (ids) => {
      await new Promise((r) => setTimeout(r, 350)); // feels like a real lookup
      return Object.fromEntries(ids.map((id) => [id, FACTS[id] || { exists: false }]));
    },
    wallets: [{ name: 'Demo Wallet', get: () => window.demoWallet }],
  };

  // ---- what the fake site asks for ---------------------------------------
  const SCENARIOS = {
    connect: {
      danger: false,
      call: () => demoWallet.requestSignIn({ contractId: 'airdrop.thrivee-demo.near', methodNames: [] }),
    },
    swap: {
      danger: false,
      call: () => demoWallet.signAndSendTransaction({
        receiverId: 'dex.thrivee-demo.near',
        actions: [{ type: 'FunctionCall', params: { methodName: 'swap', args: { token_out: 'usdt.thrivee-demo.near', min_out: '4100000' }, gas: '100000000000000', deposit: NEAR(1) } }],
      }),
    },
    tip: {
      danger: false,
      call: () => demoWallet.signAndSendTransaction({
        receiverId: 'new-creator.thrivee-demo.near',
        actions: [{ type: 'Transfer', params: { deposit: NEAR(2) } }],
      }),
    },
    list: {
      danger: false,
      call: () => demoWallet.signAndSendTransaction({
        receiverId: 'nft.thrivee-demo.near',
        actions: [{ type: 'FunctionCall', params: { methodName: 'nft_approve', args: { token_id: '77', account_id: 'market.thrivee-demo.near' }, gas: '100000000000000', deposit: '1' } }],
      }),
    },
    claim: {
      danger: 'A full-access key was added. The attacker now controls the whole account.',
      call: () => demoWallet.signAndSendTransaction({
        receiverId: YOU,
        actions: [{ type: 'AddKey', params: { publicKey: 'ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcc', accessKey: { permission: 'FullAccess' } } }],
      }),
    },
    verify: {
      danger: 'All USDT was sent to the drainer address.',
      call: () => demoWallet.requestSignTransactions({
        transactions: [
          { receiverId: 'usdt.thrivee-demo.near', actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer', args: { receiver_id: 'drainer.thrivee-demo.near', amount: '2450000000' }, gas: '30000000000000', deposit: '1' } }] },
        ],
      }),
    },
  };

  // ---- page wiring -------------------------------------------------------
  const log = () => document.getElementById('log');

  function addLog(cls, title, lines) {
    const empty = document.getElementById('log-empty');
    if (empty) empty.remove();
    const li = document.createElement('li');
    li.className = `entry ${cls}`;
    const h = document.createElement('div');
    h.className = 'entry-title';
    h.textContent = title;
    li.appendChild(h);
    for (const t of lines) {
      const p = document.createElement('div');
      p.className = 'entry-line';
      p.textContent = t;
      li.appendChild(p);
    }
    log().prepend(li);
  }

  window.addEventListener('thrivee-decision', (e) => {
    const d = e.detail;
    const label = { allow: 'ALLOWED', warn: 'WARNING', block: 'BLOCKED' }[d.verdict];
    addLog(d.verdict, `${label}: ${d.actions[0] || d.method}`, [d.findings[0] ? d.findings[0].title : '', `Outcome: ${d.outcome}`]);
  });

  async function runScenario(name) {
    const s = SCENARIOS[name];
    try {
      await s.call();
      if (s.danger) addLog('lost', 'SIGNED: the attack worked', [s.danger, shieldOn ? '' : 'The shield was off, so nothing stopped it.'].filter(Boolean));
      else if (!shieldOn) addLog('plain', 'Signed in the wallet', ['The shield was off, so nothing was checked.']);
    } catch (err) {
      if (!/ThriveeShield/.test(err.message)) addLog('plain', 'Stopped in the wallet', [err.message]);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    for (const btn of document.querySelectorAll('[data-scenario]')) {
      btn.addEventListener('click', () => runScenario(btn.dataset.scenario));
    }
    const toggle = document.getElementById('shield-toggle');
    const state = document.getElementById('shield-state');
    toggle.addEventListener('change', () => {
      shieldOn = toggle.checked;
      state.textContent = shieldOn ? 'Shield is ON' : 'Shield is OFF';
      document.body.classList.toggle('shield-off', !shieldOn);
    });
    document.getElementById('log-clear').addEventListener('click', () => {
      log().replaceChildren();
    });
    if (document.documentElement.dataset.thriveeShield === 'extension') {
      document.getElementById('ext-note').hidden = false;
    }
  });
})();
