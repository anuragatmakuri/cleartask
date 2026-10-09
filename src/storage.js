import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export function defaultDatabase() {
  return resolve(homedir(), ".cleartask", "cleartask.sqlite");
}

export class SQLiteStore {
  constructor(path = defaultDatabase()) {
    this.path = path === ":memory:" ? path : resolve(path);
    if (path !== ":memory:") {
      const directory = dirname(this.path);
      const newDirectory = !existsSync(directory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (newDirectory) chmodSync(directory, 0o700);
      if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw new Error("Database symlinks are not allowed.");
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = DELETE;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('schema_version', '1'), ('revision', '0');
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL CHECK(kind IN ('task','project','space')),
        id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id)
      );
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'Audit history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'Audit history is append-only'); END;
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    `);
    if (this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value !== "1") throw new Error("Unsupported database schema.");
    if (path !== ":memory:") chmodSync(this.path, 0o600);
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revision() { return Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value); }
  bump() { this.db.prepare("UPDATE meta SET value = CAST(value AS INTEGER)+1 WHERE key='revision'").run(); }
  snapshot() {
    const records = { task: [], project: [], space: [] };
    for (const row of this.db.prepare("SELECT kind,json FROM records ORDER BY rowid").all()) records[row.kind].push(JSON.parse(row.json));
    const state = Object.fromEntries(this.db.prepare("SELECT key,json FROM state").all().map(row => [row.key, JSON.parse(row.json)]));
    return { records, state };
  }
  put(kind, record) {
    this.db.prepare("INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json")
      .run(kind, record.id, JSON.stringify(record));
  }
  setState(name, value) {
    this.db.prepare("INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json").run(name, JSON.stringify(value));
  }
  event(value) { this.db.prepare("INSERT INTO events(json) VALUES (?)").run(JSON.stringify(value)); }
  history(limit = 30, offset = 0) {
    return this.db.prepare("SELECT sequence,json FROM events ORDER BY sequence DESC LIMIT ? OFFSET ?").all(limit, offset)
      .map(row => ({ sequence: row.sequence, ...JSON.parse(row.json) }));
  }
  request(key, digest) {
    const row = this.db.prepare("SELECT * FROM requests WHERE key=?").get(key);
    if (row && row.digest !== digest) throw new Error("Idempotency key was already used for a different request.");
    return row ? JSON.parse(row.result) : null;
  }
  remember(key, digest, result) {
    this.db.prepare("INSERT INTO requests VALUES (?,?,?)").run(key, digest, JSON.stringify(result));
  }
  plan(id) {
    const row = this.db.prepare("SELECT json FROM plans WHERE id=?").get(id);
    if (!row) throw new Error("Preview plan not found.");
    return JSON.parse(row.json);
  }
  savePlan(plan) {
    this.db.prepare("INSERT INTO plans VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(plan.id, JSON.stringify(plan));
  }
  close() { this.db.close(); }
}
