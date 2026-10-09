#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, statSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SQLiteStore, defaultDatabase } from "./storage.js";
import { ClearTask } from "./domain.js";
import { convertFirestoreExport } from "./migration.js";
import { serve } from "./server.js";

const HELP = `ClearTask local MCP (Node >=22.13)
  serve [--db PATH]                         Run stdio MCP; no HTTP listener
  status [--db PATH]                        Show local record counts/revision
  plan ID [--db PATH]                       Inspect the exact pending plan
  approve ID --digest SHA [--db PATH]       Owner-only plan approval
  export --output FILE [--db PATH]          Private JSON snapshot (no overwrite)
  backup --output FILE [--db PATH]          Private SQLite backup (no overwrite)
  import FILE [--db PATH]                   Validate only; no destination writes
  import FILE --confirm [--db PATH]         Import into an empty destination
  convert-firestore FILE --output FILE      Convert a prepared JSON export only
  help

Dates require an explicit timezone offset. Set TZ before starting for local
calendar rules. ChatGPT connection is not configured or verified.
Never share your database or exports publicly. No keys are needed for serve.`;

function loadJSON(path) {
  if (statSync(path).size > 20 * 1024 * 1024) throw new Error("Input exceeds 20 MiB.");
  return JSON.parse(readFileSync(path, "utf8"));
}
function outputFile(path) {
  if (!path) throw new Error("--output FILE is required.");
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error("Output already exists; choose a new file.");
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  return absolute;
}
function writePrivate(path, value) {
  const output = outputFile(path);
  writeFileSync(output, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
async function main() {
  // Protect SQLite journals and backup files from their first creation.
  process.umask(0o077);
  const command = process.argv[2] ?? "serve";
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3), allowPositionals: true,
    options: { db: { type: "string" }, output: { type: "string" }, digest: { type: "string" }, confirm: { type: "boolean", default: false } },
  });
  if (command === "help" || command === "--help") { console.log(HELP); return; }
  const allowed = ["serve", "status", "plan", "approve", "export", "backup", "import", "convert-firestore"];
  if (!allowed.includes(command)) throw new Error("Unknown command. Run cleartask-mcp help.");
  const needsPosition = ["plan", "approve", "import", "convert-firestore"].includes(command);
  if (positionals.length !== (needsPosition ? 1 : 0)) throw new Error("Unexpected or missing positional argument. Run help.");
  if (values.confirm && command !== "import") throw new Error("--confirm is only used for import.");
  if (values.digest && command !== "approve") throw new Error("--digest is only used for approve.");
  if (values.output && !["export", "backup", "convert-firestore"].includes(command)) throw new Error("--output is not supported by this command.");
  if (command === "serve") { await serve(values.db ?? defaultDatabase()); return; }
  if (command === "convert-firestore") {
    writePrivate(values.output, convertFirestoreExport(loadJSON(positionals[0])));
    console.log("Converted a prepared export. No database was changed."); return;
  }
  const dryRun = command === "import" && !values.confirm;
  const store = new SQLiteStore(dryRun ? ":memory:" : (values.db ?? defaultDatabase()));
  const core = new ClearTask(store);
  try {
    if (command === "status") {
      const snapshot = store.snapshot();
      console.log(JSON.stringify({ revision: store.revision(), counts: Object.fromEntries(Object.entries(snapshot.records).map(([kind, rows]) => [kind, rows.length])) }, null, 2));
    } else if (command === "plan") console.log(JSON.stringify(store.plan(positionals[0]), null, 2));
    else if (command === "approve") {
      if (!values.digest) throw new Error("Read the plan first; supply its exact --digest.");
      console.log(JSON.stringify(core.approve(positionals[0], values.digest)));
    } else if (command === "export") {
      writePrivate(values.output, core.exportSnapshot());
      console.log("Private snapshot exported; treat it as personal data.");
    } else if (command === "backup") {
      const output = outputFile(values.output);
      store.db.prepare("VACUUM INTO ?").run(output);
      chmodSync(output, 0o600);
      console.log("Private SQLite backup created.");
    } else if (command === "import") {
      const snapshot = core.validateImport(loadJSON(positionals[0]));
      if (dryRun) console.log(JSON.stringify({ valid: true, dryRun: true, counts: Object.fromEntries(Object.entries(snapshot.records).map(([kind, rows]) => [kind, rows.length])) }));
      else console.log(JSON.stringify(core.importSnapshot(snapshot)));
    }
  } finally { store.close(); }
}
main().catch(error => {
  // Stderr only: stdout is reserved for MCP protocol when serving.
  console.error(error instanceof Error ? error.message : "ClearTask failed.");
  process.exitCode = 1;
});
