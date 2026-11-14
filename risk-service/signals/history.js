// Signal 3: prior interactions between this agent's vault and the receiver (contract view).
export async function historySignal(receiver, { view }) {
  const stats = await view('receiver_stats', { account: receiver });
  const count = Number(stats?.paid_count ?? 0);
  if (count === 0) {
    return { signal: 'history', level: 'info', detail: 'this vault has never paid the receiver before', data: { paidCount: 0 } };
  }
  return { signal: 'history', level: 'ok', detail: `this vault has paid the receiver ${count} time(s) before`, data: { paidCount: count } };
}
