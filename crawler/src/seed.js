import fs from 'node:fs/promises';
import { pool } from './db.js';
import { config } from './config.js';
import { normalizeUrl } from './normalize.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run seed -- urls.txt');
  process.exit(1);
}

const text = await fs.readFile(file, 'utf8');
let added = 0;
for (const line of text.split(/\r?\n/)) {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) continue;
  try {
    const url = normalizeUrl(raw);
    const host = new URL(url).host;
    const result = await pool.query(`
      INSERT INTO crawl_targets (url, host, interval_minutes)
      VALUES ($1,$2,$3)
      ON CONFLICT (url) DO NOTHING
    `, [url, host, config.defaultIntervalMinutes]);
    added += result.rowCount;
  } catch (err) {
    console.error(`Skipping ${raw}: ${err.message}`);
  }
}
console.log(`Added ${added} targets`);
await pool.end();
