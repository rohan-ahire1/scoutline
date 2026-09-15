import pg from 'pg';
import { config } from './config.js';

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query(text, params = []) {
  return pool.query(text, params);
}
