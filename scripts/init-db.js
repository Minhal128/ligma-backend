import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from '../db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sql = readFileSync(join(__dirname, '../db/schema.sql'), 'utf8');
await pool.query(sql);
console.log('Schema applied successfully');
await pool.end();
