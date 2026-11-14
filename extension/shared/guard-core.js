// ThriveeShield guard core.
// Pure logic, no network and no DOM: reads a wallet request, returns a verdict.
// Loaded as a classic script by the extension, by the web demo and by the Node tests,
// so it attaches to globalThis instead of using import/export.
(function (root) {
  'use strict';

  const YOCTO = 10n ** 24n;
  const LARGE_NEAR = 10n * YOCTO; // a transfer or deposit this big gets a second look
  const MIN_AGE_DAYS = 7;
  const LEVELS = { ok: 0, info: 1, warn: 2, block: 3 };

  const TOKEN_TRANSFER = ['ft_transfer', 'ft_transfer_call', 'nft_transfer', 'nft_transfer_call'];
  const APPROVALS = ['nft_approve', 'approve', 'set_approval_for_all', 'increase_allowance'];

  function toBig(v) {
    if (v === undefined || v === null || v === '') return 0n;
    if (typeof v === 'bigint') return v;
    try {
      if (typeof v === 'number') return BigInt(Math.trunc(v));
      return BigInt(String(v).trim());
    } catch {
      return 0n;
    }
  }

  function fmtNear(yocto) {
    const v = toBig(yocto);
    const whole = v / YOCTO;
    const frac = (v % YOCTO).toString().padStart(24, '0').slice(0, 4).replace(/0+$/, '');
    return (frac ? `${whole}.${frac}` : `${whole}`) + ' NEAR';
  }

  function parseArgs(args) {
    if (args === undefined || args === null) return {};
    if (typeof args === 'object' && !ArrayBuffer.isView(args) && !Array.isArray(args)) return args;
    let text = null;
    try {
      if (ArrayBuffer.isView(args) || Array.isArray(args)) {
        text = new TextDecoder().decode(Uint8Array.from(args));
      } else if (typeof args === 'string') {
        text = args;
      }
      if (text === null) return {};
      try {
        return JSON.parse(text);
      } catch {
        return JSON.parse(atob(text)); // some wallets take base64 JSON
      }
    } catch {
      return { _unreadable: true };
    }
  }

  function accessKeyInfo(accessKey) {
    const p = accessKey && accessKey.permission;
    if (!accessKey || p === undefined || p === null) return { fullAccess: true };
    if (p === 'FullAccess' || p.fullAccess !== undefined) return { fullAccess: true };
    const fc = p.functionCall || p.FunctionCall || p;
    return {
      fullAccess: false,
      receiverId: fc.receiverId || fc.receiver_id || '',
      methodNames: fc.methodNames || fc.method_names || [],
      allowance: fc.allowance === undefined || fc.allowance === null ? null : String(fc.allowance),
    };
  }

  // Wallets accept several action shapes. Reduce them all to { kind, ... }.
  function normalizeAction(a) {
    if (!a || typeof a !== 'object') return { kind: 'Unknown' };
    let type = a.type;
    let p = a.params || a;
    if (!type) {
      const keys = ['functionCall', 'transfer', 'addKey', 'deleteKey', 'deployContract', 'deleteAccount', 'stake', 'createAccount'];
      const hit = keys.find((k) => a[k] !== undefined && a[k] !== null) || (typeof a.enum === 'string' ? a.enum : null);
      if (hit) {
        type = hit[0].toUpperCase() + hit.slice(1);
        p = a[hit] || {};
      } else if (a.methodName || a.method_name) {
        type = 'FunctionCall'; // Sender's short form
      }
    }
    switch (type) {
      case 'FunctionCall':
        return {
          kind: 'FunctionCall',
          method: p.methodName || p.method_name || '',
          args: parseArgs(p.args),
          deposit: toBig(p.deposit).toString(),
        };
      case 'Transfer':
        return { kind: 'Transfer', deposit: toBig(p.deposit !== undefined ? p.deposit : p.amount).toString() };
      case 'AddKey':
        return { kind: 'AddKey', publicKey: String(p.publicKey || p.public_key || ''), ...accessKeyInfo(p.accessKey || p.access_key) };
      case 'DeleteKey':
        return { kind: 'DeleteKey', publicKey: String(p.publicKey || p.public_key || '') };
      case 'DeployContract':
        return { kind: 'DeployContract' };
      case 'DeleteAccount':
        return { kind: 'DeleteAccount', beneficiary: p.beneficiaryId || p.beneficiary_id || '' };
      case 'Stake':
        return { kind: 'Stake', deposit: toBig(p.stake).toString() };
      case 'CreateAccount':
        return { kind: 'CreateAccount' };
      default:
        return { kind: 'Unknown' };
    }
  }

  const ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;

  function b64ToBytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Reads a borsh-encoded NEAR transaction (the form Meteor sends). Throws if it is not one.
  function decodeBorshTx(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 0;
    const need = (n) => {
      if (o + n > bytes.length) throw new Error('truncated');
    };
    const u8 = () => (need(1), bytes[o++]);
    const u32 = () => {
      need(4);
      const v = dv.getUint32(o, true);
      o += 4;
      return v;
    };
    const u64 = () => {
      need(8);
      const v = dv.getBigUint64(o, true);
      o += 8;
      return v;
    };
    const u128 = () => {
      const lo = u64();
      return (u64() << 64n) | lo;
    };
    const raw = (n) => {
      need(n);
      const v = bytes.subarray(o, o + n);
      o += n;
      return v;
    };
    const str = () => new TextDecoder().decode(raw(u32()));
    const pubkey = () => {
      const t = u8();
      if (t === 0) raw(32);
      else if (t === 1) raw(64);
      else throw new Error('unknown key type');
    };

    const signerId = str();
    pubkey();
    u64(); // nonce
    const receiverId = str();
    raw(32); // block hash
    if (!ACCOUNT_ID.test(signerId) || !ACCOUNT_ID.test(receiverId)) throw new Error('not a transaction');
    const count = u32();
    if (count > 100) throw new Error('too many actions');
    const actions = [];
    for (let i = 0; i < count; i++) {
      const kind = u8();
      if (kind === 0) actions.push({ kind: 'CreateAccount' });
      else if (kind === 1) {
        raw(u32());
        actions.push({ kind: 'DeployContract' });
      } else if (kind === 2) {
        const method = str();
        const args = parseArgs(raw(u32()));
        u64(); // gas
        actions.push({ kind: 'FunctionCall', method, args, deposit: u128().toString() });
      } else if (kind === 3) actions.push({ kind: 'Transfer', deposit: u128().toString() });
      else if (kind === 4) {
        const deposit = u128().toString();
        pubkey();
        actions.push({ kind: 'Stake', deposit });
      } else if (kind === 5) {
        pubkey();
        u64(); // access key nonce
        if (u8() === 1) actions.push({ kind: 'AddKey', publicKey: '', fullAccess: true });
        else {
          const allowance = u8() === 1 ? u128().toString() : null;
          const keyReceiver = str();
          const methodNames = [];
          const n = u32();
          if (n > 200) throw new Error('too many methods');
          for (let j = 0; j < n; j++) methodNames.push(str());
          actions.push({ kind: 'AddKey', publicKey: '', fullAccess: false, receiverId: keyReceiver, methodNames, allowance });
        }
      } else if (kind === 6) {
        pubkey();
        actions.push({ kind: 'DeleteKey', publicKey: '' });
      } else if (kind === 7) actions.push({ kind: 'DeleteAccount', beneficiary: str() });
      else {
        // Newer action types (delegate, global contracts): flag it and stop, the rest cannot be read safely.
        actions.push({ kind: 'Unknown' });
        break;
      }
    }
    return { signerId, receiverId, actions };
  }

  function normalizeTx(t) {
    if (typeof t === 'string' || ArrayBuffer.isView(t)) {
      try {
        return decodeBorshTx(typeof t === 'string' ? b64ToBytes(t.trim()) : new Uint8Array(t.buffer, t.byteOffset, t.byteLength));
      } catch {
        return { opaque: true, actions: [] };
      }
    }
    if (!t || typeof t !== 'object' || !Array.isArray(t.actions)) return { opaque: true, actions: [] };
    return {
      signerId: t.signerId || t.signer_id || '',
      receiverId: t.receiverId || t.receiver_id || '',
      actions: t.actions.map(normalizeAction),
    };
  }

  // method: the wallet function the site called. args: its argument list.
  function normalizeRequest(method, args) {
    const a = (args && args[0]) || {};
    const m = String(method || '');
    if (/signin/i.test(m)) {
      const contractId = typeof a === 'string' ? a : a.contractId || a.contract_id || '';
      return { kind: 'signIn', method: m, signIn: { contractId, methodNames: (typeof a === 'object' && (a.methodNames || a.method_names)) || [] } };
    }
    if (/message|verifyOwner/i.test(m)) {
      return { kind: 'message', method: m, message: { text: String(a.message || ''), recipient: String(a.recipient || '') } };
    }
    if (/sendMoney/i.test(m)) {
      return { kind: 'transactions', method: m, transactions: [{ signerId: '', receiverId: a.receiverId || '', actions: [{ kind: 'Transfer', deposit: toBig(a.amount).toString() }] }] };
    }
    if (/transaction/i.test(m)) {
      const list = Array.isArray(a) ? a : Array.isArray(a.transactions) ? a.transactions : [a];
      return { kind: 'transactions', method: m, transactions: list.map(normalizeTx) };
    }
    return { kind: 'unknown', method: m };
  }

  function findTransactions(obj, depth) {
    if (!obj || typeof obj !== 'object' || ArrayBuffer.isView(obj) || depth > 4) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, 'transactions')) return obj.transactions;
    for (const v of Object.values(obj)) {
      const r = findTransactions(v, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  // Popup and message based wallets (Meteor, Intear) send the request as a message.
  // Returns null when the message carries no transactions, so handshakes pass untouched.
  function extractTransactions(data) {
    let raw;
    try {
      raw = findTransactions(data, 0);
    } catch {
      return null;
    }
    if (raw === undefined || raw === null) return null;
    let list;
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s) return null;
      if (s[0] === '[' || s[0] === '{') {
        try {
          const j = JSON.parse(s);
          list = Array.isArray(j) ? j : [j];
        } catch {
          list = [s];
        }
      } else {
        list = s.split(','); // Meteor: comma-joined base64 transactions
      }
    } else {
      list = Array.isArray(raw) ? raw : [raw];
    }
    if (!list.length) return null;
    let key;
    try {
      key = typeof raw === 'string' ? raw : JSON.stringify(raw, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch {
      key = String(Date.now());
    }
    return { key, request: { kind: 'transactions', method: 'wallet message', transactions: list.map(normalizeTx) } };
  }

  function isImplicit(id) {
    return /^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id);
  }

  // Every account the verdict depends on, so the caller can look them up first.
  function accountsToLookup(req) {
    const ids = new Set();
    if (req.kind === 'signIn' && req.signIn.contractId) ids.add(req.signIn.contractId);
    if (req.kind === 'transactions') {
      for (const tx of req.transactions) {
        if (tx.receiverId) ids.add(tx.receiverId);
        for (const act of tx.actions) {
          if (act.kind === 'FunctionCall') {
            const to = act.args && (act.args.receiver_id || act.args.account_id);
            if (typeof to === 'string' && to) ids.add(to);
          }
          if (act.kind === 'DeleteAccount' && act.beneficiary) ids.add(act.beneficiary);
        }
      }
    }
    return [...ids];
  }

  function describeAction(act, tx) {
    switch (act.kind) {
      case 'Transfer':
        return `Send ${fmtNear(act.deposit)} to ${tx.receiverId}`;
      case 'FunctionCall': {
        // Below 0.0001 NEAR is the 1-yocto "security deposit" many calls need, not a payment.
        const dep = toBig(act.deposit) >= YOCTO / 10000n ? ` with ${fmtNear(act.deposit)} attached` : '';
        const to = act.args && (act.args.receiver_id || act.args.account_id);
        const target = TOKEN_TRANSFER.includes(act.method) && to ? `, moving tokens to ${to}` : '';
        return `Call ${act.method || '(unnamed method)'} on ${tx.receiverId}${dep}${target}`;
      }
      case 'AddKey':
        return act.fullAccess
          ? `Add a FULL-ACCESS key to ${tx.receiverId}`
          : `Add a limited key to ${tx.receiverId} for contract ${act.receiverId || '(none)'}`;
      case 'DeleteKey':
        return `Delete a key from ${tx.receiverId}`;
      case 'DeployContract':
        return `Deploy contract code onto ${tx.receiverId}`;
      case 'DeleteAccount':
        return `Delete the account ${tx.receiverId} and send everything to ${act.beneficiary || '(unknown)'}`;
      case 'Stake':
        return `Stake ${fmtNear(act.deposit)} from ${tx.receiverId}`;
      case 'CreateAccount':
        return `Create the account ${tx.receiverId}`;
      default:
        return 'An action ThriveeShield could not read';
    }
  }

  // Adds findings about one account the money or the permission goes to.
  function checkCounterparty(id, role, info, out) {
    const i = (info && info[id]) || {};
    if (i.blocked) {
      out.push({ level: 'block', title: `${id} is on the scam blocklist`, detail: `The ${role} has been reported and confirmed as malicious.` });
      return;
    }
    if (i.exists === undefined || i.exists === null) {
      out.push({ level: 'info', title: `Could not look up ${id}`, detail: `The chain lookup for the ${role} failed or timed out, so its age and history were not checked.` });
    }
    if (i.reports > 0) {
      out.push({ level: 'warn', title: `${id} has ${i.reports} unconfirmed scam report(s)`, detail: 'Other users reported this address. Nobody has confirmed it yet.' });
    }
    if (i.exists === false) {
      if (isImplicit(id)) {
        out.push({ level: 'info', title: `${id.slice(0, 10)}... is a brand-new address`, detail: 'It has never been used. That is normal for a fresh wallet, but check it twice.' });
      } else {
        out.push({ level: 'warn', title: `${id} does not exist`, detail: `The ${role} is not an account on this network. The request will fail or the name is a typo.` });
      }
      return;
    }
    if (typeof i.ageDays === 'number' && !i.ageAtLeast && i.ageDays < MIN_AGE_DAYS) {
      out.push({ level: 'warn', title: `${id} is only ${Math.max(0, Math.floor(i.ageDays))} day(s) old`, detail: `Scam accounts are usually new. The ${role} was created very recently.` });
    }
    if (i.codeChanged) {
      out.push({ level: 'warn', title: `${id} changed its contract code`, detail: 'The code is different from the last time you used it.' });
    }
  }

  function evalTx(tx, ctx, out) {
    if (tx.opaque) {
      out.push({ level: 'warn', title: 'This transaction is encoded', detail: 'ThriveeShield cannot read what it does. Only continue if you fully trust this site.' });
      return;
    }
    const info = ctx.info || {};
    const creates = tx.actions.some((a) => a.kind === 'CreateAccount');
    checkCounterparty(tx.receiverId, 'receiver', info, out);

    for (const act of tx.actions) {
      if (act.kind === 'AddKey' && !creates) {
        if (act.fullAccess) {
          out.push({
            level: 'block',
            title: 'This would hand over your whole account',
            detail: `It adds a full-access key to ${tx.receiverId}. Whoever holds that key can take every token and NFT. Real apps never ask for this.`,
          });
        } else {
          const methods = act.methodNames.length ? act.methodNames.join(', ') : 'any method';
          out.push({ level: 'warn', title: 'Adds a new key to your account', detail: `The key can call ${methods} on ${act.receiverId || '(no contract)'} without asking you again.` });
        }
      }
      if (act.kind === 'DeleteAccount') {
        out.push({ level: 'block', title: 'This would delete your account', detail: `Everything in ${tx.receiverId} would be sent to ${act.beneficiary || 'another account'}. It cannot be undone.` });
      }
      if (act.kind === 'DeployContract' && !creates) {
        out.push({ level: 'block', title: 'This would install code on your account', detail: `New contract code on ${tx.receiverId} can move your funds without any further approval.` });
      }
      if (act.kind === 'DeleteKey') {
        out.push({ level: 'warn', title: 'Deletes a key from your account', detail: 'If it is your own key you can be locked out. Only wallets should manage keys.' });
      }
      if (act.kind === 'Stake') {
        out.push({ level: 'warn', title: `Stakes ${fmtNear(act.deposit)}`, detail: 'Staked NEAR is locked. Check that you meant to do this.' });
      }
      if (act.kind === 'Transfer' && toBig(act.deposit) >= LARGE_NEAR) {
        out.push({ level: 'warn', title: `Large transfer: ${fmtNear(act.deposit)}`, detail: `Check the receiver ${tx.receiverId} letter by letter.` });
      }
      if (act.kind === 'Unknown') {
        out.push({ level: 'warn', title: 'Contains an action ThriveeShield could not read', detail: 'Only continue if you fully trust this site.' });
      }
      if (act.kind === 'FunctionCall') {
        const rinfo = info[tx.receiverId] || {};
        if (rinfo.exists && rinfo.isContract === false) {
          out.push({ level: 'warn', title: `${tx.receiverId} has no contract`, detail: `The site calls ${act.method} on an account with no code. The call will fail.` });
        }
        if (toBig(act.deposit) >= LARGE_NEAR) {
          out.push({ level: 'warn', title: `Large deposit: ${fmtNear(act.deposit)}`, detail: `This call sends ${fmtNear(act.deposit)} to ${tx.receiverId}.` });
        }
        const to = act.args && (act.args.receiver_id || act.args.account_id);
        if (TOKEN_TRANSFER.includes(act.method) && typeof to === 'string' && to) {
          checkCounterparty(to, 'token receiver', info, out);
        }
        if (APPROVALS.includes(act.method)) {
          if (typeof to === 'string' && to) checkCounterparty(to, 'approved account', info, out);
          out.push({ level: 'warn', title: 'Gives someone permission over your assets', detail: `${act.method} lets ${to || 'another account'} move your tokens or NFTs later, without asking.` });
        }
        if (act.args && act.args._unreadable) {
          out.push({ level: 'info', title: 'Call arguments could not be read', detail: `ThriveeShield checked the contract ${tx.receiverId} but not what is sent to it.` });
        }
      }
    }
  }

  // ctx: { origin, info: { [accountId]: { exists, isContract, ageDays, ageAtLeast, blocked, reports, codeChanged } }, siteBlocked }
  function evaluate(req, ctx) {
    ctx = ctx || {};
    const findings = [];
    const actions = [];

    if (ctx.siteBlocked) {
      findings.push({ level: 'block', title: 'This website is on the scam blocklist', detail: `${ctx.origin || 'This site'} has been reported as a phishing site.` });
    }

    if (req.kind === 'signIn') {
      const { contractId, methodNames } = req.signIn;
      if (!contractId) {
        actions.push('Share your account name with this site');
        findings.push({ level: 'ok', title: 'No spending permission asked', detail: 'The site only learns your account name.' });
      } else {
        const methods = methodNames.length ? methodNames.join(', ') : 'any method';
        actions.push(`Connect, and let this site call ${methods} on ${contractId}`);
        checkCounterparty(contractId, 'contract', ctx.info, findings);
        findings.push({ level: 'info', title: 'Creates a limited key', detail: `The site can call ${contractId} without asking again. A limited key cannot send your NEAR.` });
      }
    } else if (req.kind === 'transactions') {
      for (const tx of req.transactions) {
        for (const act of tx.actions) actions.push(describeAction(act, tx));
        evalTx(tx, ctx, findings);
      }
      if (req.transactions.length > 1) {
        findings.push({ level: 'info', title: `${req.transactions.length} transactions in one request`, detail: 'One approval in your wallet signs all of them.' });
      }
    } else if (req.kind === 'message') {
      actions.push('Sign a text message (no funds move)');
      findings.push({ level: 'ok', title: 'Message signing does not move funds', detail: req.message.recipient ? `The message is meant for ${req.message.recipient}.` : 'It proves you own the account.' });
    } else {
      actions.push(`Wallet request: ${req.method}`);
      findings.push({ level: 'warn', title: 'Unknown wallet request', detail: 'ThriveeShield does not recognise this request type.' });
    }

    let top = 'ok';
    for (const f of findings) if (LEVELS[f.level] > LEVELS[top]) top = f.level;
    const verdict = top === 'block' ? 'block' : top === 'warn' ? 'warn' : 'allow';
    findings.sort((x, y) => LEVELS[y.level] - LEVELS[x.level]);
    if (verdict === 'allow' && !findings.some((f) => f.level === 'ok')) {
      findings.push({ level: 'ok', title: 'No risks found', detail: 'Nothing unusual is being asked.' });
    }
    return { verdict, actions, findings };
  }

  // ---- Account check-up -------------------------------------------------
  // data: { accountId, account: { amount, code_hash }, keys: [{ public_key, access_key }], txns: [{ counterparty, when }], info }
  function auditAccount(data) {
    const findings = [];
    const info = data.info || {};
    const keys = (data.keys || []).map((k) => {
      const perm = k.access_key && k.access_key.permission;
      if (perm === 'FullAccess') return { publicKey: k.public_key, fullAccess: true };
      const fc = (perm && perm.FunctionCall) || {};
      return { publicKey: k.public_key, fullAccess: false, receiverId: fc.receiver_id || '', methodNames: fc.method_names || [], allowance: fc.allowance || null };
    });

    const full = keys.filter((k) => k.fullAccess);
    const limited = keys.filter((k) => !k.fullAccess);

    if (full.length === 0) {
      findings.push({ level: 'info', title: 'No full-access key', detail: 'Nobody, including you, can move funds or change this account directly.' });
    } else if (full.length === 1) {
      findings.push({ level: 'ok', title: 'One full-access key', detail: 'Only one key controls the account. Keep its seed phrase offline.' });
    } else {
      findings.push({
        level: full.length > 3 ? 'block' : 'warn',
        title: `${full.length} full-access keys`,
        detail: 'Each one can take everything. Every wallet you imported this account into adds one. Delete the ones you no longer use.',
      });
    }

    const byContract = {};
    for (const k of limited) (byContract[k.receiverId] = byContract[k.receiverId] || []).push(k);
    for (const [contract, list] of Object.entries(byContract)) {
      const i = info[contract] || {};
      if (i.blocked) {
        findings.push({ level: 'block', title: `A key is open for ${contract}, a blocklisted contract`, detail: 'Delete this key in your wallet now.' });
      } else if (i.exists === false) {
        findings.push({ level: 'warn', title: `Key for ${contract}, which no longer exists`, detail: 'The app is gone. If someone re-creates that name, the key works for them. Delete it.' });
      } else if (list.length > 3) {
        findings.push({ level: 'info', title: `${list.length} keys for ${contract}`, detail: 'Old sign-ins pile up. You can delete the extras.' });
      }
    }
    if (limited.length > 25) {
      findings.push({ level: 'warn', title: `${limited.length} app keys on this account`, detail: 'Each site you ever connected left a key. Clean up the ones you do not use.' });
    } else if (limited.length > 0 && !findings.some((f) => /key/i.test(f.title) && f.level !== 'ok' && f.level !== 'info')) {
      findings.push({ level: 'ok', title: `${limited.length} app key(s), all for live contracts`, detail: 'These keys can call their app but cannot send your NEAR.' });
    }

    const code = data.account && data.account.code_hash;
    if (code && code !== '11111111111111111111111111111111') {
      findings.push({ level: 'warn', title: 'A contract is installed on this account', detail: 'Normal wallets have no code. If you did not deploy it, your account may be compromised.' });
    }

    const seen = new Set();
    for (const t of data.txns || []) {
      const c = t.counterparty;
      if (!c || seen.has(c)) continue;
      seen.add(c);
      const i = info[c] || {};
      if (i.blocked) findings.push({ level: 'block', title: `Recent activity with ${c}, a blocklisted address`, detail: 'Check what you approved there and remove any key for it.' });
    }
    if ((data.txns || []).length && ![...seen].some((c) => (info[c] || {}).blocked)) {
      findings.push({ level: 'ok', title: `No blocklisted address in the last ${data.txns.length} transactions`, detail: 'This only compares against the ThriveeShield blocklist. It does not prove every address was honest.' });
    }

    let score = 100;
    for (const f of findings) score -= f.level === 'block' ? 35 : f.level === 'warn' ? 12 : 0;
    score = Math.max(0, score);
    const grade = score >= 85 ? 'Good' : score >= 60 ? 'Needs attention' : 'At risk';
    findings.sort((x, y) => LEVELS[y.level] - LEVELS[x.level]);
    return { accountId: data.accountId, score, grade, findings, keys: { full: full.length, limited: limited.length, byContract } };
  }

  root.ThriveeGuard = { normalizeAction, normalizeRequest, extractTransactions, decodeBorshTx, accountsToLookup, evaluate, auditAccount, describeAction, fmtNear, isImplicit, LEVELS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
