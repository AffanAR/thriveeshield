// ThriveeShield risk service: POST /check -> { verdict: allow|warn|block, reasons: [...] }
// Advisory only. The vault contract enforces the final verdict on-chain.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProvider, view as chainView, NETWORKS } from '../lib/chain.js';
import { checkReceiver } from './engine.js';
import { Snapshots } from './snapshots.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createServer({ rpcUrl, vaultId, indexer = null, snapshotFile = path.join(here, 'snapshots.json') }) {
  const provider = makeProvider(rpcUrl);
  const snapshots = new Snapshots(snapshotFile);
  const deps = { provider, vaultId, snapshots, indexer, view: (m, a) => chainView(provider, vaultId, m, a) };

  return http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, vault: vaultId });
      if (req.method === 'POST' && req.url === '/check') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 10_000) return send(413, { error: 'body too large' });
        }
        const body = JSON.parse(raw || '{}');
        if (typeof body.receiver !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(body.receiver)) {
          return send(400, { error: 'receiver must be a NEAR account id' });
        }
        if (!/^\d+$/.test(String(body.amount ?? ''))) {
          return send(400, { error: 'amount must be a yoctoNEAR integer string' });
        }
        return send(200, await checkReceiver({ receiver: body.receiver, amount: String(body.amount) }, deps));
      }
      return send(404, { error: 'not found' });
    } catch (err) {
      // Fail closed: if the service cannot decide, tell the wrapper to hold the payment.
      return send(200, {
        verdict: 'warn',
        reasons: [{ signal: 'service', level: 'warn', detail: `risk service error, failing closed: ${err.message}` }],
      });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const network = process.env.NETWORK || 'testnet';
  const vaultId = process.env.VAULT_ID;
  if (!vaultId) {
    console.error('Set VAULT_ID (see .env.example).');
    process.exit(1);
  }
  const rpcUrl = process.env.NEAR_RPC_URL || NETWORKS[network].rpcUrl;
  const server = createServer({ rpcUrl, vaultId, indexer: NETWORKS[network].indexer });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, '127.0.0.1', () => console.log(`risk service for ${vaultId} on http://127.0.0.1:${port}`));
}
