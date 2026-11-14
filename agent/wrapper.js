// The agent-side wrapper. Every payment an agent wants to make goes through pay().
//
//   1. Ask the risk service about the receiver.
//   2. BLOCK -> refuse. Nothing is signed, nothing is sent.
//   3. ALLOW or WARN -> sign request_payment with the agent's function-call key.
//      The vault contract then decides again on-chain. A WARN is held as a pending payment and a
//      human is asked (onWarn). Only the owner key, which the agent never holds, can release it.
//
// The agent signs with a function-call access key scoped to the vault contract and to two methods.
// It never holds a full-access key.
import fs from 'node:fs';
import path from 'node:path';
import { accountFrom, call, describeError, explorerLink, makeProvider } from '../lib/chain.js';

export class ShieldedWallet {
  /**
   * @param {object} o
   * @param {string} o.vaultId vault contract account (the agent key lives on this account)
   * @param {string} o.agentSecretKey the function-call key (ed25519:...)
   * @param {string} o.rpcUrl
   * @param {string} o.serviceUrl risk service base URL
   * @param {string} [o.network] sandbox | testnet (for explorer links)
   * @param {(info:object)=>Promise<object>|object} [o.onWarn] asks a human; returns { action }
   * @param {string} [o.logFile] JSON-lines log of everything the wrapper does
   * @param {(line:string)=>void} [o.print] console output sink
   */
  constructor({ vaultId, agentSecretKey, rpcUrl, serviceUrl, network = 'testnet', onWarn, logFile, print = console.log }) {
    this.vaultId = vaultId;
    this.serviceUrl = serviceUrl;
    this.network = network;
    this.onWarn = onWarn;
    this.logFile = logFile;
    this.print = print;
    this.provider = makeProvider(rpcUrl);
    this.agent = accountFrom(vaultId, agentSecretKey, this.provider);
    if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  log(event, data = {}) {
    const entry = { at: new Date().toISOString(), event, ...data };
    if (this.logFile) fs.appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  async check(to, amount) {
    try {
      const r = await fetch(`${this.serviceUrl}/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ receiver: to, amount: String(amount) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`risk service HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      // Fail closed: no answer from the risk service means a human must look at it.
      return { verdict: 'warn', reasons: [{ signal: 'service', level: 'warn', detail: `risk service unreachable (${err.message}), failing closed` }] };
    }
  }

  /** The only way the agent moves money. */
  async pay({ to, amount, memo = null, source = 'agent' }) {
    const amountStr = String(amount);
    this.log('payment_requested', { to, amount: amountStr, memo, source });
    const check = await this.check(to, amountStr);
    this.log('risk_check', { to, verdict: check.verdict, reasons: check.reasons.map((r) => `${r.signal}: ${r.detail}`) });

    if (check.verdict === 'block') {
      const entry = this.log('refused_before_signing', { to, amount: amountStr, note: 'no transaction was signed or sent' });
      return { status: 'refused', check, entry };
    }

    let res;
    try {
      res = await call(this.agent, this.vaultId, 'request_payment', { receiver: to, amount: amountStr, memo });
    } catch (err) {
      const reason = describeError(err);
      this.log('chain_error', { to, reason });
      return { status: 'error', check, reason };
    }
    const outcome = res.value;
    const link = explorerLink(this.network, res.txHash);
    this.log('request_payment_signed', { to, txHash: res.txHash, verdict: outcome?.verdict, reason: outcome?.reason, link });

    if (outcome?.verdict === 'ALLOW') return { status: 'paid', check, outcome, txHash: res.txHash, link };
    if (outcome?.verdict === 'BLOCK') {
      this.log('blocked_on_chain', { to, reason: outcome.reason });
      return { status: 'blocked_on_chain', check, outcome, txHash: res.txHash, link };
    }

    // WARN: the contract holds the payment as pending. Ask a human.
    const info = { id: outcome.pending_id, to, amount: amountStr, reason: outcome.reason, reasons: check.reasons };
    this.log('human_asked', info);
    const answer = this.onWarn ? await this.onWarn(info) : { action: 'queue' };
    this.log('human_answered', { id: info.id, action: answer?.action || 'queue' });
    return { status: 'pending', check, outcome, pendingId: info.id, human: answer, txHash: res.txHash, link };
  }

  /** Report an address to the shared blocklist, with evidence. One report only raises WARN. */
  async report(target, evidence) {
    const res = await call(this.agent, this.vaultId, 'report_address', { target, evidence });
    this.log('reported', { target, evidence, txHash: res.txHash });
    return res;
  }
}
