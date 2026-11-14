// Runs in the extension's isolated world. The interceptor (inject.js) lives in the page and
// cannot use chrome.* APIs, so it posts its questions here and this relays them to the
// background worker, which does the chain lookups.
(function () {
  'use strict';
  const TYPES = new Set(['lookup', 'decision']);
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== 'thrivee-page' || !TYPES.has(d.type)) return;
    try {
      chrome.runtime.sendMessage({ type: d.type, payload: d.payload }, (result) => {
        if (chrome.runtime.lastError || d.type !== 'lookup') return;
        window.postMessage({ source: 'thrivee-ext', id: d.id, result }, window.location.origin);
      });
    } catch { /* extension was reloaded; the interceptor times out and warns */ }
  });
})();
