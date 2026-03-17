const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function openDatabase(dbPath) {
  const absPath = path.resolve(dbPath || path.join(process.cwd(), 'wf-server', 'data', 'wf.db'));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const db = new Database(absPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  return db;
}

function runMigrations(db) {
  const sqlPath = path.join(__dirname, 'migrations', '001_init.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  db.exec(sql);
}

module.exports = {
  openDatabase,
  runMigrations,
};
