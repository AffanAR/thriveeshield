// Renders the demo run as one self-contained HTML page (evidence/demo-report.html).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TONES = [
  [/\b(allow|ALLOW|paid|approved|PASS)\b/g, 'ok'],
  [/\b(warn|WARN|pending|held)\b/g, 'warn'],
  [/\b(block|BLOCK|blocked|refused|REJECTED|FAIL)\b/g, 'bad'],
];
function colour(line) {
  let out = esc(line);
  for (const [re, tone] of TONES) out = out.replace(re, (m) => `<b class="${tone}">${m}</b>`);
  return out;
}

export function renderReport({ network, vaultId, ownerId, agentPublicKey, permission, sections, results, generatedAt }) {
  const failed = results.filter((r) => !r.ok).length;
  const cards = sections.map((s) => {
    const bad = s.checks.filter((c) => !c.ok).length;
    const chip = s.checks.length ? `<span class="chip ${bad ? 'bad' : 'ok'}">${s.checks.length - bad}/${s.checks.length} checks</span>` : '';
    const checks = s.checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}"><span class="mark">${c.ok ? '&#10003;' : '&#10007;'}</span>${esc(c.label)}${c.detail ? ` <span class="muted">(${esc(c.detail)})</span>` : ''}</li>`).join('');
    return `<section class="card">
      <header><h2>${esc(s.title)}</h2>${chip}</header>
      ${s.lines.length ? `<pre>${s.lines.map(colour).join('\n')}</pre>` : ''}
      ${checks ? `<ul class="checks">${checks}</ul>` : ''}
    </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ThriveeShield demo run</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#15181d; --muted:#667085; --line:#e3e6eb; --code:#f1f3f6;
          --ok:#0b7a43; --okbg:#e3f6ec; --warn:#9a5b00; --warnbg:#fdf0d5; --bad:#b42318; --badbg:#fde7e4; --accent:#00a86b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0e1116; --card:#161a21; --ink:#e8ebf0; --muted:#98a2b3; --line:#262c36; --code:#0e1116;
            --ok:#4ade80; --okbg:#0f2e1e; --warn:#fbbf24; --warnbg:#33260a; --bad:#f87171; --badbg:#361513; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 16px 56px; }
  .top { display:flex; flex-wrap:wrap; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:20px; }
  h1 { margin:0; font-size:28px; letter-spacing:-0.02em; }
  h1 span { color:var(--accent); }
  .sub { color:var(--muted); margin-top:4px; }
  .result { font-weight:700; font-size:16px; padding:10px 16px; border-radius:999px; }
  .result.ok { background:var(--okbg); color:var(--ok); } .result.bad { background:var(--badbg); color:var(--bad); }
  .meta { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-bottom:20px; }
  .meta div { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; min-width:0; }
  .meta small { display:block; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; font-size:11px; margin-bottom:2px; }
  .meta code { font:13px/1.4 ui-monospace, Consolas, monospace; word-break:break-all; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin-bottom:16px; }
  .card header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }
  h2 { margin:0; font-size:17px; }
  .chip { font-size:12px; font-weight:700; padding:3px 10px; border-radius:999px; white-space:nowrap; }
  .chip.ok { background:var(--okbg); color:var(--ok); } .chip.bad { background:var(--badbg); color:var(--bad); }
  pre { margin:0 0 12px; padding:12px 14px; background:var(--code); border:1px solid var(--line); border-radius:10px;
        font:12.5px/1.6 ui-monospace, Consolas, monospace; white-space:pre-wrap; word-break:break-word; overflow-x:auto; }
  b.ok { color:var(--ok); } b.warn { color:var(--warn); } b.bad { color:var(--bad); }
  .checks { list-style:none; margin:0; padding:0; display:grid; gap:4px; }
  .checks li { display:flex; gap:8px; align-items:baseline; }
  .checks .mark { font-weight:700; } .checks li.ok .mark { color:var(--ok); } .checks li.bad .mark { color:var(--bad); }
  .muted { color:var(--muted); }
  footer { color:var(--muted); font-size:13px; margin-top:24px; }
</style>
</head>
<body>
<main>
  <div class="top">
    <div>
      <h1>Thrivee<span>Shield</span> demo run</h1>
      <div class="sub">Counterparty checks and an on-chain policy vault for AI agents that pay, on NEAR</div>
    </div>
    <div class="result ${failed ? 'bad' : 'ok'}">${failed ? `${failed} of ${results.length} checks failed` : `All ${results.length} checks passed`}</div>
  </div>
  <div class="meta">
    <div><small>Network</small><code>${esc(network)}</code></div>
    <div><small>Vault contract</small><code>${esc(vaultId)}</code></div>
    <div><small>Owner (human)</small><code>${esc(ownerId)}</code></div>
    <div><small>Agent key</small><code>${esc(agentPublicKey)}</code></div>
    <div style="grid-column:1/-1"><small>Agent key permission, read from the chain</small><code>${esc(permission)}</code></div>
  </div>
  ${cards}
  <footer>Generated by <code>node agent/demo.js</code> on ${esc(generatedAt)}. The agent in this demo is scripted, no live LLM.</footer>
</main>
</body>
</html>
`;
}
