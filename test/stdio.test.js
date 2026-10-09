import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
test("official SDK stdio discovery, CRUD, CLI-approved deletion, and restart without keys", { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "cleartask-stdio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "tasks.sqlite");
  const env = { HOME: dir, TZ: "America/Chicago", PATH: process.env.PATH };
  let client;
  async function connect() {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "serve", "--db", db], env, stderr: "pipe" });
    // Only expected built-in SQLite warnings; never forward private stderr.
    const stderr = [];
    transport.stderr?.on("data", chunk => stderr.push(String(chunk)));
    client = new Client({ name: "cleartask-integration-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return transport;
  }
  await connect();
  t.after(async () => { if (client) await client.close(); });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent;
  };
  const tools = await client.listTools();
  assert.ok(tools.tools.some(t => t.name === "create_task"));
  assert.ok(tools.tools.some(t => t.name === "preview_changes"));
  assert.ok(tools.tools.some(t => t.name === "get_cleanup_suggestions"));
  assert.ok(tools.tools.some(t => t.name === "record_cleanup_action"));
  assert.ok(tools.tools.some(t => t.name === "record_project_review_decision"));
  assert.ok(tools.tools.some(t => t.name === "get_weekly_diagnostics"));
  assert.equal(tools.tools.some(t => /approve/i.test(t.name)), false);
  assert.equal(tools.tools.find(t => t.name === "get_record").annotations.readOnlyHint, true);
  const input = { data: { title: "SDK task" }, idempotencyKey: "sdk-create-1" };
  const created = await call("create_task", input);
  assert.deepEqual(await call("create_task", input), created);
  const id = created.createdIds[0].id;
  const vague = await call("create_task", { data: { title: "Fix" }, idempotencyKey: "sdk-vague-1" });
  const vagueId = vague.createdIds[0].id;
  const cleanup = await call("get_cleanup_suggestions", {});
  const suggestion = cleanup.suggestions.find(item => item.taskId === vagueId && item.type === "vague");
  assert.ok(suggestion);
  const cleanupResult = await call("record_cleanup_action", {
    itemType: "suggestion", suggestionId: suggestion.id, taskId: vagueId,
    expectedVersion: 1, action: "rewrite_title", newTitle: "Fix the broken latch",
    idempotencyKey: "sdk-cleanup-rewrite",
  });
  assert.equal(cleanupResult.changes[0].after.title, "Fix the broken latch");
  let task = await call("get_record", { entity: "task", id });
  const edited = await call("change_record", { operation: { entity: "task", action: "update", id, expectedVersion: task.version, data: { title: "SDK edited" } }, idempotencyKey: "sdk-edit-1" });
  assert.equal(edited.changes[0].after.title, "SDK edited");
  const stale = await client.callTool({ name: "change_record", arguments: { operation: { entity: "task", action: "complete", id, expectedVersion: task.version }, idempotencyKey: "sdk-stale-1" } });
  assert.equal(stale.isError, true);
  task = await call("get_record", { entity: "task", id });
  await call("change_record", { operation: { entity: "task", action: "complete", id, expectedVersion: task.version }, idempotencyKey: "sdk-done-1" });
  assert.equal((await call("get_weekly_diagnostics", {})).last7.completed, 1);
  task = await call("get_record", { entity: "task", id });
  await call("change_record", { operation: { entity: "task", action: "reopen", id, expectedVersion: task.version }, idempotencyKey: "sdk-reopen-1" });
  task = await call("get_record", { entity: "task", id });
  await call("start_focus", { taskId: id, idempotencyKey: "sdk-focus-1" });
  const plan = await call("preview_changes", { operations: [{ entity: "task", action: "delete", id, expectedVersion: task.version }], idempotencyKey: "sdk-delete-1" });
  const unapproved = await client.callTool({ name: "apply_changes", arguments: { planId: plan.id } });
  assert.equal(unapproved.isError, true);
  const owner = spawnSync(process.execPath, [cli, "approve", plan.id, "--digest", plan.digest, "--db", db], { env, encoding: "utf8" });
  assert.equal(owner.status, 0, owner.stderr);
  const result = await call("apply_changes", { planId: plan.id });
  assert.ok(result.changes[0].after.deletedAt);
  assert.deepEqual(await call("apply_changes", { planId: plan.id }), result);
  const malformed = await client.callTool({ name: "create_task", arguments: { data: { title: "", apiKey: "not-a-secret-placeholder" }, idempotencyKey: "sdk-invalid-1" } });
  assert.equal(malformed.isError, true);
  const resources = await client.listResources();
  assert.equal(resources.resources[0].uri, "cleartask://usage");
  await client.close();
  await connect();
  assert.ok((await call("get_record", { entity: "task", id })).deletedAt);
  assert.equal((await call("get_session_state", {})).focus.taskId, id);
  await call("end_focus", { idempotencyKey: "sdk-focus-end" });
  await client.close(); client = null;
});
