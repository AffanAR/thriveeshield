// Signal 4: the shared blocklist. Reports (with reporter and evidence) and owner-confirmed blocks
// both live in the vault contract. Anyone can report; only the owner can confirm.
export async function blocklistSignal(receiver, { view }) {
  const [blocked, reports] = await Promise.all([
    view('is_blocked', { account: receiver }),
    view('get_reports', { account: receiver }),
  ]);
  const evidence = (reports || []).map((r) => ({ reporter: r.reporter, evidence: r.evidence }));
  if (blocked) {
    return { signal: 'blocklist', level: 'block', detail: `receiver is on the confirmed blocklist (${evidence.length} report(s))`, data: { blocked: true, reports: evidence } };
  }
  if (evidence.length > 0) {
    return { signal: 'blocklist', level: 'warn', detail: `receiver has ${evidence.length} unconfirmed report(s)`, data: { blocked: false, reports: evidence } };
  }
  return { signal: 'blocklist', level: 'ok', detail: 'receiver is not reported', data: { blocked: false, reports: [] } };
}
