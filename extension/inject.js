// ThriveeShield interceptor. Runs inside the page (MAIN world), before the site's own scripts.
// It wraps the signing methods of injected NEAR wallets. Every request is read and checked
// first; only then is it handed to the real wallet, which still shows its own confirmation.
// The same file runs in the extension and in the web demo.
(function () {
  'use strict';
  if (window.__thriveeShieldLoaded) return;
  try {
    Object.defineProperty(window, '__thriveeShieldLoaded', { value: true });
  } catch {
    return;
  }

  const G = window.ThriveeGuard;
  if (!G) return;

  // The web demo sets this before loading the script. In the extension it is absent,
  // because a page script cannot run before a document_start content script.
  const demo = window.__THRIVEE_DEMO__ || null;
  const mode = demo ? 'demo' : 'extension';
  document.documentElement.dataset.thriveeShield = mode;

  // Globals and channels read from the wallets' own adapters: @near-wallet-selector 10.1.4
  // (sender, bitget-wallet, okx-wallet, nightly, hot-wallet, intear-wallet), @hot-wallet/sdk 1.0.11
  // and @meteorwallet/sdk 3.24.1.
  const WALLETS = [
    { name: 'Sender', get: () => window.near },
    { name: 'Bitget Wallet', get: () => window.bitkeep && window.bitkeep.near },
    { name: 'OKX Wallet', get: () => window.okxwallet && window.okxwallet.near },
    { name: 'Nightly', get: () => window.nightly && window.nightly.near },
  ].concat((demo && demo.wallets) || []); // the web demo adds its simulated wallet here
  const METHODS = [
    'requestSignIn', 'signAndSendTransaction', 'signAndSendTransactions', 'requestSignTransactions',
    'signTransaction', 'signTransactions', 'signAllTransactions', 'sendMoney', 'signMessage', 'verifyOwner',
  ];
  // HOT's extension has one entry point, request(method, payload). Only these are signing requests.
  const HOT_METHODS = ['near:signAndSendTransactions', 'near:signAndSendTransaction', 'near:signMessage'];
  // Web wallets that receive the request by postMessage into a popup they own.
  const POPUP_WALLETS = [
    { name: 'Meteor Wallet', host: 'wallet.meteorwallet.app' },
    { name: 'Intear Wallet', host: 'wallet.intear.tech' },
  ];
  const LOOKUP_TIMEOUT_MS = 6000;

  // ---- lookups: ask the extension (or the demo) about the accounts involved ----
  let seq = 0;
  const waiting = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'thrivee-ext') return;
    const done = waiting.get(e.data.id);
    if (done) {
      waiting.delete(e.data.id);
      done(e.data.result || {});
    }
  });

  function ask(type, payload) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${++seq}`;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({});
      }, LOOKUP_TIMEOUT_MS);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      window.postMessage({ source: 'thrivee-page', id, type, payload }, window.location.origin);
    });
  }

  async function lookup(ids) {
    if (!ids.length) return { info: {}, siteBlocked: false };
    try {
      if (demo) return { info: await demo.lookup(ids), siteBlocked: false };
      const r = await ask('lookup', { ids, host: location.hostname });
      return { info: r.info || {}, siteBlocked: !!r.siteBlocked };
    } catch {
      return { info: {}, siteBlocked: false };
    }
  }

  function report(decision) {
    try {
      window.dispatchEvent(new CustomEvent('thrivee-decision', { detail: decision }));
      if (!demo) window.postMessage({ source: 'thrivee-page', id: `d-${++seq}`, type: 'decision', payload: decision }, window.location.origin);
    } catch { /* reporting must never break the page */ }
  }

  // ---- UI (shadow DOM so the site's CSS cannot restyle or hide it) ----
  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    .veil{position:fixed;inset:0;z-index:2147483647;background:rgba(8,12,20,.72);display:flex;align-items:center;justify-content:center;padding:16px;animation:fade .15s ease-out}
    .card{width:100%;max-width:460px;max-height:calc(100vh - 32px);overflow:auto;background:#10151f;color:#e7ecf3;border-radius:16px;border:1px solid #263041;box-shadow:0 24px 70px rgba(0,0,0,.55)}
    .head{padding:18px 20px 14px;border-bottom:1px solid #222b3a;display:flex;gap:12px;align-items:flex-start}
    .badge{flex:none;width:40px;height:40px;border-radius:11px;display:grid;place-items:center;font-size:20px;font-weight:700}
    .block .badge{background:#3a1218;color:#ff7a85}.warn .badge{background:#3a2a0c;color:#ffc24d}
    .kicker{font-size:11px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;margin:1px 0 3px}
    .block .kicker{color:#ff7a85}.warn .kicker{color:#ffc24d}
    h2{margin:0;font-size:18px;line-height:1.3;font-weight:650;color:#fff}
    .body{padding:14px 20px 4px}
    .meta{font-size:12.5px;color:#93a0b4;margin:0 0 12px}
    .meta b{color:#cbd5e3;font-weight:600}
    .label{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#7f8ca1;font-weight:700;margin:12px 0 6px}
    ul{list-style:none;margin:0;padding:0}
    .acts li{font:13px/1.45 ui-monospace,Consolas,monospace;background:#0a0e16;border:1px solid #1f2836;border-radius:8px;padding:8px 10px;margin-bottom:6px;overflow-wrap:anywhere;color:#d6dde8}
    .finds li{display:flex;gap:9px;padding:8px 0;border-top:1px solid #1c2431}
    .finds li:first-child{border-top:0}
    .dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px}
    .l-block{background:#ff5c6a}.l-warn{background:#ffb020}.l-info{background:#6aa7ff}.l-ok{background:#37d67a}
    .ft{font-size:13.5px;font-weight:600;color:#f1f4f8;overflow-wrap:anywhere}
    .fd{font-size:12.5px;line-height:1.45;color:#9aa7ba;margin-top:2px;overflow-wrap:anywhere}
    .foot{padding:14px 20px 18px;display:flex;gap:10px;flex-wrap:wrap}
    button{flex:1 1 150px;border:0;border-radius:10px;padding:11px 14px;font-size:14px;font-weight:650;cursor:pointer}
    button:focus-visible{outline:2px solid #8ab4ff;outline-offset:2px}
    .safe{background:#e7ecf3;color:#0d1117}.safe:hover{background:#fff}
    .risky{background:transparent;color:#9aa7ba;border:1px solid #2b3648}.risky:hover{color:#ffc24d;border-color:#6b5320}
    .note{padding:0 20px 16px;font-size:11.5px;color:#6f7c91}
    .toast{position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#10151f;color:#e7ecf3;border:1px solid #1f4d33;border-radius:12px;padding:10px 14px;font-size:13px;display:flex;gap:9px;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.4);animation:rise .2s ease-out;max-width:calc(100vw - 32px)}
    .toast i{font-style:normal;color:#37d67a;font-weight:700}
    @keyframes fade{from{opacity:0}to{opacity:1}}
    @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @media (prefers-reduced-motion:reduce){.veil,.toast{animation:none}}
  `;

  function mount() {
    const host = document.createElement('thrivee-shield');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    return { host, shadow };
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text; // textContent only: site-controlled strings never become HTML
    return n;
  }

  function toast(text) {
    const { host, shadow } = mount();
    const t = el('div', 'toast');
    t.setAttribute('role', 'status');
    t.appendChild(el('i', '', '✓'));
    t.appendChild(el('span', '', text));
    shadow.appendChild(t);
    setTimeout(() => host.remove(), 2600);
  }

  // Resolves true (continue to the wallet) or false (stop).
  function dialog(wallet, result) {
    return new Promise((resolve) => {
      const { host, shadow } = mount();
      const blocked = result.verdict === 'block';
      const veil = el('div', `veil ${blocked ? 'block' : 'warn'}`);
      const card = el('div', 'card');
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-label', blocked ? 'ThriveeShield blocked a request' : 'ThriveeShield warning');

      const head = el('div', 'head');
      head.appendChild(el('div', 'badge', blocked ? '✕' : '!'));
      const ht = el('div');
      ht.appendChild(el('div', 'kicker', blocked ? 'ThriveeShield blocked this' : 'ThriveeShield warning'));
      ht.appendChild(el('h2', '', result.findings[0] ? result.findings[0].title : 'This request looks risky'));
      head.appendChild(ht);
      card.appendChild(head);

      const body = el('div', 'body');
      const meta = el('p', 'meta');
      meta.appendChild(el('b', '', location.hostname || 'This page'));
      meta.appendChild(document.createTextNode(' asked '));
      meta.appendChild(el('b', '', wallet));
      meta.appendChild(document.createTextNode(' to:'));
      body.appendChild(meta);
      const acts = el('ul', 'acts');
      for (const a of result.actions.slice(0, 8)) acts.appendChild(el('li', '', a));
      if (result.actions.length > 8) acts.appendChild(el('li', '', `...and ${result.actions.length - 8} more`));
      body.appendChild(acts);
      body.appendChild(el('div', 'label', 'What we found'));
      const finds = el('ul', 'finds');
      for (const f of result.findings) {
        const li = el('li');
        li.appendChild(el('span', `dot l-${f.level}`));
        const box = el('div');
        box.appendChild(el('div', 'ft', f.title));
        box.appendChild(el('div', 'fd', f.detail));
        li.appendChild(box);
        finds.appendChild(li);
      }
      body.appendChild(finds);
      card.appendChild(body);

      const foot = el('div', 'foot');
      const finish = (go) => {
        document.removeEventListener('keydown', onKey, true);
        host.remove();
        resolve(go);
      };
      const safe = el('button', 'safe', blocked ? 'Close' : 'Cancel (recommended)');
      safe.addEventListener('click', () => finish(false));
      foot.appendChild(safe);
      if (!blocked) {
        const risky = el('button', 'risky', 'Continue to wallet');
        risky.addEventListener('click', () => finish(true));
        foot.appendChild(risky);
      }
      card.appendChild(foot);
      card.appendChild(el('div', 'note', blocked
        ? 'Your wallet was never asked to sign this.'
        : 'If you continue, your wallet will still ask you to confirm.'));
      function onKey(e) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(false);
        }
      }
      document.addEventListener('keydown', onKey, true);
      veil.appendChild(card);
      shadow.appendChild(veil);
      safe.focus();
    });
  }

  // ---- the guard itself ----
  function guard(wallet, method, args, forward) {
    return decide(wallet, method, () => G.normalizeRequest(method, args), forward);
  }

  // Runs the check for one request. Calls forward() when it may go to the wallet, throws when not.
  async function decide(wallet, method, readRequest, forward) {
    if (demo && demo.isEnabled && !demo.isEnabled()) return forward();
    let req;
    let result;
    try {
      req = readRequest();
      const { info, siteBlocked } = await lookup(G.accountsToLookup(req));
      result = G.evaluate(req, { origin: location.hostname, info, siteBlocked });
    } catch (err) {
      // Fail closed to a warning: a request we could not check is never silently passed.
      result = { verdict: 'warn', actions: [`Wallet request: ${method}`], findings: [{ level: 'warn', title: 'ThriveeShield could not check this request', detail: String((err && err.message) || err) }] };
    }
    const decision = { time: Date.now(), host: location.hostname, wallet, method, kind: req ? req.kind : 'unknown', verdict: result.verdict, actions: result.actions, findings: result.findings, outcome: '' };

    if (result.verdict === 'allow') {
      decision.outcome = 'passed to wallet';
      report(decision);
      toast('ThriveeShield checked this request: no risks found');
      return forward();
    }
    const go = await dialog(wallet, result);
    decision.outcome = result.verdict === 'block' ? 'blocked' : go ? 'user continued' : 'user cancelled';
    report(decision);
    if (go) return forward();
    throw new Error(result.verdict === 'block'
      ? `ThriveeShield blocked this request: ${result.findings[0].title}`
      : 'ThriveeShield: request cancelled by the user');
  }

  function wrap(obj, name) {
    for (const m of METHODS) {
      let orig;
      try {
        orig = obj[m];
      } catch {
        continue;
      }
      if (typeof orig !== 'function' || orig.__thrivee) continue;
      const wrapped = function (...args) {
        return guard(name, m, args, () => orig.apply(this, args));
      };
      Object.defineProperty(wrapped, '__thrivee', { value: true });
      try {
        obj[m] = wrapped;
        if (obj[m] !== wrapped) Object.defineProperty(obj, m, { value: wrapped, configurable: true, writable: true });
      } catch {
        try {
          Object.defineProperty(obj, m, { value: wrapped, configurable: true, writable: true });
        } catch { /* frozen wallet object: cannot guard this method */ }
      }
    }
  }

  // ---- message based wallets (Meteor, Intear) ----
  // The site sends the same message repeatedly until the wallet answers, so remember the
  // decision per request and let nothing through until it is "go".
  const verdicts = new Map();
  function guardMessage(wallet, data, forward, abort) {
    let found = null;
    try {
      found = G.extractTransactions(data);
    } catch { /* not a transaction message */ }
    if (!found) return forward();
    const state = verdicts.get(found.key);
    if (state === 'go') return forward();
    if (state) return undefined; // still deciding, or refused
    verdicts.set(found.key, 'deciding');
    decide(wallet, 'wallet message', () => found.request, () => {
      verdicts.set(found.key, 'go');
      return forward();
    }).catch(() => {
      verdicts.set(found.key, 'stop');
      // Forget the refusal after a while, so the user can retry the same request on purpose.
      setTimeout(() => verdicts.delete(found.key), 15000);
      if (abort) abort();
    });
    return undefined;
  }

  function markGuarded(name) {
    if (guarded.has(name)) return;
    guarded.add(name);
    document.documentElement.dataset.thriveeWallets = [...guarded].join(', ');
    try {
      window.dispatchEvent(new CustomEvent('thrivee-wallet', { detail: { wallet: name } }));
    } catch { /* ignore */ }
  }

  function replace(obj, key, wrapped) {
    Object.defineProperty(wrapped, '__thrivee', { value: true });
    try {
      obj[key] = wrapped;
      if (obj[key] !== wrapped) Object.defineProperty(obj, key, { value: wrapped, configurable: true, writable: true });
    } catch {
      try {
        Object.defineProperty(obj, key, { value: wrapped, configurable: true, writable: true });
      } catch { /* frozen object: cannot guard it */ }
    }
    return obj[key] === wrapped;
  }

  function wrapHot() {
    const hot = window.hotExtension;
    if (!hot || typeof hot.request !== 'function' || hot.request.__thrivee) return;
    const orig = hot.request;
    const ok = replace(hot, 'request', function (method, payload) {
      if (!HOT_METHODS.includes(method)) return orig.apply(this, arguments);
      return guard('HOT Wallet', method, [payload], () => orig.apply(this, arguments));
    });
    if (ok) markGuarded('HOT Wallet');
  }

  function wrapMeteorExtension() {
    const com = window.meteorCom;
    if (!com || typeof com.sendMessageData !== 'function' || com.sendMessageData.__thrivee) return;
    const orig = com.sendMessageData;
    const ok = replace(com, 'sendMessageData', function (data) {
      return guardMessage('Meteor Wallet', data, () => orig.apply(this, arguments));
    });
    if (ok) markGuarded('Meteor Wallet');
  }

  // Popup wallets: hand the site a stand-in for the popup window whose postMessage we can check.
  const realOpen = window.open;
  if (typeof realOpen === 'function') {
    const openGuarded = function (url) {
      const win = realOpen.apply(window, arguments);
      let host = '';
      try {
        host = new URL(String(url), location.href).hostname;
      } catch { /* not a URL */ }
      const wallet = POPUP_WALLETS.find((w) => w.host === host);
      if (!win || !wallet) return win;
      markGuarded(wallet.name);
      return new Proxy(win, {
        get(target, prop) {
          if (prop === 'postMessage') {
            return function (data) {
              const args = arguments;
              return guardMessage(wallet.name, data, () => target.postMessage.apply(target, args), () => {
                try {
                  target.close();
                } catch { /* already closed */ }
              });
            };
          }
          let v;
          try {
            v = target[prop];
          } catch {
            return undefined; // cross-origin windows expose only a few properties
          }
          return typeof v === 'function' ? v.bind(target) : v;
        },
        set(target, prop, value) {
          try {
            target[prop] = value;
          } catch { /* cross-origin */ }
          return true;
        },
      });
    };
    try {
      window.open = openGuarded;
    } catch { /* cannot replace window.open on this page */ }
  }

  const guarded = new Set();
  function scan() {
    try {
      wrapHot();
      wrapMeteorExtension();
    } catch { /* a wallet object that throws on access is left alone */ }
    for (const w of WALLETS) {
      let obj;
      try {
        obj = w.get();
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      wrap(obj, w.name);
      markGuarded(w.name);
    }
  }

  // Wallets inject at different moments, so keep looking. Re-wrapping is a no-op.
  scan();
  let ticks = 0;
  const fast = setInterval(() => {
    scan();
    if (++ticks > 80) {
      clearInterval(fast);
      setInterval(scan, 2000);
    }
  }, 250);
  window.addEventListener('load', scan);
})();
