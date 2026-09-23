import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const withoutDatabase = { ...process.env, DATABASE_URL: '' };

// The scraping engine must import without a database so Scoutline can scrape
// locally. db.js (worker/dashboard/export) must still fail fast instead.
test('engine imports without DATABASE_URL', async () => {
  const target = join(here, 'siteCrawler.js');
  const { stdout } = await run(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(target)}); console.log('engine-ok')`],
    { env: withoutDatabase, timeout: 30000 }
  );
  assert.match(stdout, /engine-ok/);
});

test('db.js fails fast without DATABASE_URL', async (t) => {
  try {
    await import('pg');
  } catch {
    t.skip('pg is not installed; run npm install first');
    return;
  }
  const target = join(here, 'db.js');
  const failed = await run(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(target)})`],
    { env: withoutDatabase, timeout: 30000 }
  ).then(
    () => null,
    (error) => error
  );
  assert.ok(failed, 'expected db.js import to fail without DATABASE_URL');
  assert.match(String(failed.stderr || failed.message || ''), /DATABASE_URL is required/);
});
