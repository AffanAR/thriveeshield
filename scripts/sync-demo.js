// Copies the extension's guard code into docs/shared so the web demo (GitHub Pages serves
// only docs/) runs the same files. test/guard.test.js fails if the copies drift.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHARED = [
  ['extension/shared/guard-core.js', 'docs/shared/guard-core.js'],
  ['extension/inject.js', 'docs/shared/inject.js'],
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(root, 'docs/shared'), { recursive: true });
  for (const [from, to] of SHARED) {
    fs.copyFileSync(path.join(root, from), path.join(root, to));
    console.log(`copied ${from} -> ${to}`);
  }
}
