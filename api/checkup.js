// GET /api/checkup?account=<near account>
// Reads the account's public chain data, scores it with the same rules the extension uses,
// and asks an AI model (through OpenRouter) to explain the result in plain words.
// The only input is an account name, so the model never sees free text from a visitor.
// Runs as a Vercel function and under scripts/dev-server.js.
import '../extension/shared/guard-core.js';
import { collect, validAccount } from './_lib/checkup-data.js';

const G = globalThis.ThriveeGuard;
const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';
const CACHE_MS = 10 * 60 * 1000;
const PER_MINUTE = 8;
const AI_TIMEOUT_MS = 20000;
// Generous on purpose: some models count hidden reasoning against this limit, and 350 cut
// the answer off mid-sentence on the live site. The answer itself is about 200 tokens.
const MAX_TOKENS = 1500;

const cache = new Map();
const hits = new Map();

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*'); // public chain data, GET only
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

// Best effort only: serverless instances do not share memory. The real cap is the
// spending limit set on the OpenRouter key.
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > PER_MINUTE;
}

// Finds the OpenRouter key. Accepts small naming differences (case, stray spaces, OPENROUTER_KEY).
// When nothing usable is found, the reason lists the matching variable NAMES only, never values,
// so a misnamed or empty setting can be diagnosed from the API answer.
export function findKey(env) {
  const names = Object.keys(env).filter((n) => /openrouter/i.test(n) && !/model/i.test(n));
  const exact = typeof env.OPENROUTER_API_KEY === 'string' ? env.OPENROUTER_API_KEY.trim() : '';
  if (exact) return { key: exact };
  for (const n of names) {
    const v = typeof env[n] === 'string' ? env[n].trim() : '';
    if (v && /key|token/i.test(n)) return { key: v };
  }
  const seen = names.length ? names.map((n) => `"${n}"${String(env[n] || '').trim() ? '' : ' (empty)'}`).join(', ') : 'none';
  return { key: null, reason: `no API key configured (OpenRouter variables this server sees: ${seen})` };
}

export async function explain(report, { fetchImpl = fetch, env = process.env } = {}) {
  const found = findKey(env);
  const key = found.key;
  if (!key) return { text: null, model: null, reason: found.reason };
  const model = env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const facts = {
    account: report.accountId,
    score: report.score,
    grade: report.grade,
    fullAccessKeys: report.keys.full,
    appKeys: report.keys.limited,
    findings: report.findings.map((f) => ({ level: f.level, title: f.title, detail: f.detail })),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'http-referer': 'https://shield.thrivee.tech',
        'x-title': 'ThriveeShield',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'You are the ThriveeShield security assistant. You explain a NEAR account security check-up to a person who is not technical. '
              + 'Write 3 to 5 short plain-English sentences on how safe the account looks and why, then up to 3 numbered actions, most urgent first. '
              + 'Use only the facts in the JSON you are given. Never invent addresses, numbers or events. If nothing is wrong, say so briefly. No markdown, no headings.',
          },
          { role: 'user', content: JSON.stringify(facts) },
        ],
      }),
    });
    if (!res.ok) return { text: null, model, reason: `AI service answered ${res.status}` };
    const body = await res.json();
    const choice = (body.choices && body.choices[0]) || {};
    let text = choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
    if (!text) return { text: null, model, reason: `empty AI answer (finish: ${choice.finish_reason || 'unknown'})` };
    if (choice.finish_reason === 'length') {
      // The model ran out of tokens mid-sentence: keep only whole sentences.
      const end = Math.max(text.lastIndexOf('. '), text.lastIndexOf('.\n'));
      if (end < 40) return { text: null, model, reason: 'AI answer was cut off' };
      text = text.slice(0, end + 1);
    }
    return { text, model };
  } catch (err) {
    return { text: null, model, reason: err.name === 'AbortError' ? 'AI service timed out' : 'AI service unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkup(accountId, deps = {}) {
  const data = await collect(accountId, deps.fetchImpl);
  if (data.notFound) return { notFound: true, network: data.network };
  const report = G.auditAccount(data);
  const ai = await explain(report, deps);
  return {
    accountId,
    network: data.network,
    balance: G.fmtNear(data.account.amount),
    score: report.score,
    grade: report.grade,
    findings: report.findings,
    keys: {
      full: report.keys.full,
      limited: report.keys.limited,
      apps: Object.entries(report.keys.byContract).map(([contract, list]) => ({
        contract,
        count: list.length,
        exists: (data.info[contract] || {}).exists,
        blocked: !!(data.info[contract] || {}).blocked,
      })),
    },
    transactionsChecked: data.txns.length,
    partial: data.partial,
    ai: ai.text,
    aiModel: ai.text ? ai.model : null,
    aiNote: ai.text ? null : ai.reason,
    checkedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
  const account = (new URL(req.url, 'http://localhost').searchParams.get('account') || '').trim().toLowerCase();
  if (!validAccount(account)) return send(res, 400, { error: 'That is not a valid NEAR account name.' });

  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  const hit = cache.get(account);
  if (hit && Date.now() - hit.at < CACHE_MS) return send(res, 200, hit.body);
  if (rateLimited(ip)) return send(res, 429, { error: 'Too many check-ups. Try again in a minute.' });

  try {
    const body = await checkup(account);
    if (body.notFound) return send(res, 404, { error: `${account} does not exist on ${body.network}.` });
    cache.set(account, { at: Date.now(), body });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return send(res, 200, body);
  } catch (err) {
    return send(res, 502, { error: 'Could not read the chain right now. Try again shortly.' });
  }
}
