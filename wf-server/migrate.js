const path = require('path');
const { openDatabase, runMigrations } = require('./db');

const dbPath = process.env.WF_DB_PATH || path.join(process.cwd(), 'wf-server', 'data', 'wf.db');
const db = openDatabase(dbPath);
runMigrations(db);
console.log('[WF] migrations done:', dbPath);
