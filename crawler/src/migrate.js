import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db.js';

const dir = new URL('../migrations/', import.meta.url);
const files = (await fs.readdir(dir)).filter(name => name.endsWith('.sql')).sort();
for (const file of files) {
  const sql = await fs.readFile(new URL(file, dir), 'utf8');
  console.log(`applying ${file}`);
  await pool.query(sql);
}
await pool.end();
console.log('migrations complete');
