import pool from '../db/pool.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  try {
    await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS yjs_state TEXT');
    console.log('Added yjs_state to rooms');
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();