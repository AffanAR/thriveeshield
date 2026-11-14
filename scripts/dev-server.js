// Local stand-in for the Vercel deployment: serves docs/ and mounts /api/checkup.
// Usage: npm run site   (set OPENROUTER_API_KEY in your shell to get AI summaries)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import checkup from '../api/checkup.js';

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');
const port = Number(process.env.PORT || 4175);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/checkup') return checkup(req, res);
  let file = path.join(docs, decodeURIComponent(pathname));
  if (!file.startsWith(docs)) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!path.extname(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`ThriveeShield site on http://127.0.0.1:${port}`));
