// Popup: counts and the most recent checked requests, read from the activity log.
'use strict';

chrome.storage.local.get('activity').then(({ activity = [] }) => {
  for (const v of ['allow', 'warn', 'block']) {
    document.getElementById(`n-${v}`).textContent = activity.filter((a) => a.verdict === v).length;
  }
  const list = document.getElementById('list');
  for (const a of activity.slice(0, 30)) {
    const li = document.createElement('li');
    li.className = a.verdict;
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = a.action || a.kind;
    const d = document.createElement('div');
    d.className = 'd';
    const when = new Date(a.time).toLocaleString();
    d.textContent = `${a.host} · ${a.outcome}${a.reason ? ' · ' + a.reason : ''} · ${when}`;
    li.append(t, d);
    list.appendChild(li);
  }
  document.getElementById('empty').hidden = activity.length > 0;
});
