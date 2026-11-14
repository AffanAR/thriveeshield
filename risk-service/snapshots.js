// Code-hash snapshots: remembers the code hash of each contract receiver we have seen.
import fs from 'node:fs';

export class Snapshots {
  constructor(file = null) {
    this.file = file;
    this.data = {};
    if (file && fs.existsSync(file)) {
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
    }
  }

  get(account) {
    return this.data[account] || null;
  }

  set(account, codeHash) {
    this.data[account] = { codeHash, seenAt: new Date().toISOString() };
    this.save();
  }

  save() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
