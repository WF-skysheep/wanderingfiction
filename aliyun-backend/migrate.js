const path = require('path');
const { openDatabase, runMigrations } = require('./db');

const DB_PATH = process.env.WF_DB_PATH || path.join(process.cwd(), 'aliyun-backend', 'data', 'wf.db');

const db = openDatabase(DB_PATH);
runMigrations(db);

console.log('[ALIYUN BACKEND] migrations completed');
console.log('[ALIYUN BACKEND] db:', DB_PATH);
