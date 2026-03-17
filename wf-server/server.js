const path = require('path');
const { openDatabase, runMigrations } = require('./db');
const { createAIProvider } = require('./ai-provider');
const { createApp } = require('./app');

const PORT = Number(process.env.WF_PORT || 8788);
const dbPath = process.env.WF_DB_PATH || path.join(process.cwd(), 'wf-server', 'data', 'wf.db');

const db = openDatabase(dbPath);
runMigrations(db);

const app = createApp({
  db,
  aiProvider: createAIProvider(process.env),
  corsOrigin: process.env.WF_CORS_ORIGIN || '',
});

app.listen(PORT, () => {
  console.log('[WF] server running on http://localhost:' + PORT);
  console.log('[WF] db path: ' + dbPath);
});
