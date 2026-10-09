import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStore } from "../src/storage.js";
import { ClearTask } from "../src/domain.js";
import { convertFirestoreExport } from "../src/migration.js";

function setup(t, path = ":memory:") {
  let now = new Date("2026-10-07T15:00:00Z");
  const store = new SQLiteStore(path);
  const core = new ClearTask(store, { clock: () => now });
  t.after(() => store.close());
  let index = 0;
  const mutate = (entity, action, data, record) => core.mutate({
    operation: { entity, action, ...(data ? { data } : {}), ...(record ? { id: record.id, expectedVersion: record.version } : {}) },
    idempotencyKey: `test-key-${++index}`,
  });
  const create = (entity = "task", data = { title: "A task" }) => {
    const result = mutate(entity, "create", data);
    return core.read(entity, result.createdIds[0].id);
  };
  const planFor = (entity, action, record, data) => core.preview({
    operations: [{ entity, action, id: record.id, expectedVersion: record.version, ...(data ? { data } : {}) }],
    idempotencyKey: `plan-key-${++index}`,
  });
  const apply = plan => { core.approve(plan.id, plan.digest); return core.apply(plan.id); };
  return { store, core, create, mutate, planFor, apply, setNow: date => { now = new Date(date); } };
}

test("create/read/search/update/complete/reopen/defer and derived counters", t => {
  const { core, create, mutate } = setup(t);
  const space = create("space", { name: "Work", color: "#334455" });
  const project = create("project", { name: "Release", spaceId: space.id });
  let task = create("task", { title: "Publish package", projectId: project.id });
  assert.equal(task.spaceId, space.id);
  assert.equal(core.read("space", space.id).projectCount, 1);
  assert.equal(core.read("project", project.id).openTaskCount, 1);
  mutate("task", "update", { title: "Publish stable package", description: "Test first." }, task);
  task = core.read("task", task.id);
  assert.equal(task.version, 2);
  assert.equal(core.list({ entity: "task", query: "STABLE" }).total, 1);
  mutate("task", "complete", null, task);
  assert.equal(core.read("project", project.id).openTaskCount, 0);
  task = core.read("task", task.id);
  mutate("task", "reopen", null, task);
  task = core.read("task", task.id);
  core.mutate({ operation: { entity: "task", action: "defer", id: task.id, expectedVersion: task.version, until: "2026-10-08T15:00:00Z" }, idempotencyKey: "defer-key-1" });
  assert.equal(core.list({ entity: "task" }).total, 0);
  assert.equal(core.list({ entity: "task", status: "all" }).total, 1);
  assert.equal(core.read("task", task.id).deferralCount, 1);
});

test("idempotency prevents duplicate creation and conflicting key reuse", t => {
  const { core } = setup(t);
  const input = { operation: { entity: "task", action: "create", data: { title: "Once" } }, idempotencyKey: "duplicate-key" };
  assert.deepEqual(core.mutate(input), core.mutate(input));
  assert.equal(core.list({ entity: "task" }).total, 1);
  assert.throws(() => core.mutate({ ...input, operation: { ...input.operation, data: { title: "Different" } } }), /different request/);
});

test("stale versions and unknown/protected fields fail without history changes", t => {
  const { core, create, mutate, store } = setup(t);
  const task = create();
  mutate("task", "update", { important: true }, task);
  const revision = store.revision(), count = store.history(100).length;
  assert.throws(() => mutate("task", "update", { title: "Stale" }, task), /changed/);
  assert.throws(() => mutate("task", "update", { deletedAt: "2026-10-07T15:00:00Z" }, core.read("task", task.id)), /Unrecognized|unrecognized/);
  assert.equal(store.revision(), revision);
  assert.equal(store.history(100).length, count);
});

test("subtask inheritance, depth, and completion propagation are transactional", t => {
  const { core, create, mutate } = setup(t);
  const parent = create("task", { title: "Parent" });
  const first = create("task", { title: "First", parentId: parent.id });
  const second = create("task", { title: "Second", parentId: parent.id });
  assert.throws(() => create("task", { title: "Too deep", parentId: first.id }), /top-level/);
  mutate("task", "complete", null, first);
  assert.equal(core.read("task", parent.id).completedAt, null);
  mutate("task", "complete", null, second);
  assert.ok(core.read("task", parent.id).completedAt);
  mutate("task", "reopen", null, core.read("task", first.id));
  assert.equal(core.read("task", parent.id).completedAt, null);
  assert.equal(core.read("task", parent.id).subtaskCount, 2);
  assert.throws(() => mutate("task", "update", { spaceId: "missing" }, core.read("task", first.id)), /parent/);
});

test("parent completion/reopen cascades, and adding an open child reopens parent", t => {
  const { core, create, mutate } = setup(t);
  const parent = create();
  const child = create("task", { title: "Child", parentId: parent.id });
  const result = mutate("task", "complete", null, core.read("task", parent.id));
  assert.equal(result.changes.length, 2);
  assert.ok(core.read("task", child.id).completedAt);
  create("task", { title: "New child", parentId: parent.id });
  assert.equal(core.read("task", parent.id).completedAt, null);
});

test("scope moves propagate across parent, child, and project", t => {
  const { core, create, mutate } = setup(t);
  const a = create("space", { name: "A" }), b = create("space", { name: "B" });
  const project = create("project", { name: "Project", spaceId: a.id });
  const parent = create("task", { title: "Parent", projectId: project.id });
  const child = create("task", { title: "Child", parentId: parent.id });
  mutate("project", "update", { spaceId: b.id }, project);
  assert.equal(core.read("task", parent.id).spaceId, b.id);
  assert.equal(core.read("task", child.id).spaceId, b.id);
  assert.throws(() => mutate("task", "update", { spaceId: a.id }, core.read("task", parent.id)), /mismatch/);
});

test("delete cannot run directly or with a forged approval flag", t => {
  const { core, create, mutate } = setup(t);
  const task = create();
  assert.throws(() => mutate("task", "delete", null, task), /preview/);
  assert.throws(() => core.mutate({ operation: { entity: "task", action: "delete", id: task.id, expectedVersion: task.version }, idempotencyKey: "forged-delete", approved: true }), /Unrecognized|unrecognized/);
});

test("family preview is exact, owner-approved, consumed and safely replayable", t => {
  const { core, create, planFor, store } = setup(t);
  const parent = create(), child = create("task", { title: "Child", parentId: parent.id });
  const plan = planFor("task", "delete", core.read("task", parent.id));
  assert.equal(plan.changes.length, 2);
  assert.equal(core.list({ entity: "task" }).total, 2);
  assert.throws(() => core.apply(plan.id), /not approved/);
  assert.throws(() => core.approve(plan.id, "invented"), /Digest/);
  core.approve(plan.id, plan.digest);
  const result = core.apply(plan.id);
  assert.deepEqual(core.apply(plan.id), result);
  assert.equal(store.history(100).filter(e => e.operation === "mutation").length, 3);
  assert.ok(core.read("task", parent.id).deletedAt);
  assert.ok(core.read("task", child.id).deletedAt);
});

test("family restoration does not resurrect independently deleted children", t => {
  const { core, create, planFor, apply } = setup(t);
  const parent = create();
  const independent = create("task", { title: "Previously removed", parentId: parent.id });
  const child = create("task", { title: "Included child", parentId: parent.id });
  apply(planFor("task", "delete", independent));
  apply(planFor("task", "delete", core.read("task", parent.id)));
  const plan = planFor("task", "restore", core.read("task", parent.id));
  assert.equal(plan.changes.length, 2);
  apply(plan);
  assert.equal(core.read("task", parent.id).deletedAt, null);
  assert.equal(core.read("task", child.id).deletedAt, null);
  assert.ok(core.read("task", independent.id).deletedAt);
});

test("restore cannot expose a child under a deleted parent", t => {
  const { core, create, planFor, apply, mutate } = setup(t);
  const parent = create(), child = create("task", { title: "Child", parentId: parent.id });
  apply(planFor("task", "delete", parent));
  assert.throws(() => mutate("task", "restore", null, core.read("task", child.id)), /Invalid task reference/);
  assert.ok(core.read("task", child.id).deletedAt);
});

test("expired/changed/tampered previews fail", t => {
  const { core, create, planFor, setNow, store } = setup(t);
  const task = create();
  const expired = planFor("task", "delete", task);
  setNow("2026-10-07T15:16:00Z");
  assert.throws(() => core.approve(expired.id, expired.digest), /expired/);
  const changed = planFor("task", "delete", task);
  create("space", { name: "New change" });
  assert.throws(() => core.approve(changed.id, changed.digest), /Database changed/);
  const tampered = planFor("task", "delete", task);
  tampered.changes[0].after.title = "Tampered";
  store.savePlan(tampered);
  assert.throws(() => core.approve(tampered.id, tampered.digest), /integrity/);
});

test("bulk preview fails atomically if one operation is invalid", t => {
  const { core, create, store } = setup(t);
  const task = create();
  const before = core.exportSnapshot(), revision = store.revision();
  assert.throws(() => core.preview({
    operations: [
      { entity: "task", action: "update", id: task.id, expectedVersion: task.version, data: { title: "Temporary" } },
      { entity: "task", action: "update", id: task.id, expectedVersion: task.version, data: { projectId: "missing" } },
    ], idempotencyKey: "invalid-bulk",
  }), /not found/);
  assert.deepEqual(core.exportSnapshot(), before);
  assert.equal(store.revision(), revision);
});

test("project and space deletion detach references, never delete tasks", t => {
  const { core, create, planFor, apply } = setup(t);
  const space = create("space", { name: "Space" });
  const project = create("project", { name: "Project", spaceId: space.id });
  const task = create("task", { title: "Keep", projectId: project.id });
  const child = create("task", { title: "Keep child", parentId: task.id });
  const plan = planFor("project", "delete", project);
  assert.equal(plan.changes.length, 3);
  apply(plan);
  assert.equal(core.read("task", task.id).projectId, null);
  assert.equal(core.read("task", child.id).projectId, null);
  assert.equal(core.read("task", task.id).deletedAt, null);
  apply(planFor("space", "delete", space));
  assert.equal(core.read("task", task.id).spaceId, null);
});

test("ordinary archive and weekly-review archive have distinct meanings", t => {
  const { core, create, mutate, planFor, apply } = setup(t);
  const task = create();
  mutate("task", "archive", null, task);
  assert.ok(core.read("task", task.id).completedAt);
  assert.equal(core.read("task", task.id).deletedAt, null);
  apply(planFor("task", "delete", core.read("task", task.id)));
  assert.ok(core.read("task", task.id).deletedAt);
});

test("audit history rejects updates/deletes and shares write rollback", t => {
  const { store, core, create } = setup(t);
  create();
  assert.throws(() => store.db.exec("UPDATE events SET json='{}'"), /append-only/);
  assert.throws(() => store.db.exec("DELETE FROM events"), /append-only/);
  const before = core.list({ entity: "task" }).total;
  const original = store.event;
  store.event = () => { throw new Error("Simulated audit failure"); };
  assert.throws(() => create(), /audit failure/);
  store.event = original;
  assert.equal(core.list({ entity: "task" }).total, before);
});

test("review decisions are scoped, persistent, cycle-aware and retry-safe", t => {
  const { core, create } = setup(t);
  const task = create("task", { title: "Overdue", dueDate: "2026-10-05T09:00:00Z" });
  const session = core.startReview("review-start");
  assert.ok(session.taskIds.includes(task.id));
  const args = { entity: "task", id: task.id, expectedVersion: task.version, sessionId: session.id, action: "keep", idempotencyKey: "review-keep-1" };
  assert.deepEqual(core.recordReview(args), core.recordReview(args));
  assert.equal(core.review().overdue.length, 0);
  assert.throws(() => core.recordReview({ ...args, id: "invented", idempotencyKey: "bad-review-1" }), /not in/);
  core.finishReview(session.id, "review-finish");
  assert.ok(core.store.snapshot().state.lastReviewCompletedAt);
});

test("weekly-review reschedule is atomic and archive cannot bypass approval", t => {
  const { core, create } = setup(t);
  const task = create("task", { title: "Overdue", dueDate: "2026-10-05T09:00:00Z" });
  const session = core.startReview("review-start");
  const args = { entity: "task", id: task.id, expectedVersion: task.version, sessionId: session.id, idempotencyKey: "review-change", action: "archive" };
  assert.throws(() => core.recordReview(args), /owner-approved delete plan/);
  core.recordReview({ ...args, action: "reschedule", dueDate: "2026-10-09T09:00:00Z" });
  assert.equal(core.read("task", task.id).dueDate, "2026-10-09T09:00:00Z");
  assert.ok(core.read("task", task.id).reviewedAt);
});

test("weekly diagnostics count task changes and capture review backlog snapshots", t => {
  const { core, create, mutate, setNow } = setup(t);
  let task = create();
  mutate("task", "update", { dueDate: "2026-10-08T15:00:00Z" }, task);
  task = core.read("task", task.id);
  mutate("task", "complete", null, task);
  let diagnostics = core.weeklyDiagnostics();
  assert.equal(diagnostics.last7.completed, 1);
  assert.equal(diagnostics.last7.rescheduled, 1);

  let review = core.startReview("diagnostics-review-start-1");
  core.finishReview(review.id, "diagnostics-review-finish-1");
  diagnostics = core.weeklyDiagnostics();
  assert.equal(diagnostics.last7.backlogDelta, 0);
  assert.equal(core.store.snapshot().state.weeklyDiagnosticSnapshots.length, 1);

  setNow("2026-10-14T15:00:00Z");
  review = core.startReview("diagnostics-review-start-2");
  core.finishReview(review.id, "diagnostics-review-finish-2");
  assert.equal(core.store.snapshot().state.weeklyDiagnosticSnapshots.length, 2);
});

test("cleanup exposes current app suggestions, applies approved actions, and persists seven-day skips", t => {
  const { core, create, setNow } = setup(t);
  const vague = create("task", { title: "Fix" });
  const rewrite = core.cleanup().suggestions.find(item => item.taskId === vague.id && item.type === "vague");
  assert.ok(rewrite);
  core.recordCleanupAction({
    itemType: "suggestion", suggestionId: rewrite.id, taskId: vague.id,
    expectedVersion: vague.version, action: "rewrite_title", newTitle: "Repair the front door hinge",
    idempotencyKey: "cleanup-rewrite-1",
  });
  assert.equal(core.read("task", vague.id).title, "Repair the front door hinge");

  const stale = create("task", { title: "Review the launch plan" });
  setNow("2026-11-01T15:00:00Z");
  const staleSuggestion = core.cleanup().suggestions.find(item => item.taskId === stale.id && item.type === "stale");
  assert.ok(staleSuggestion);
  const skip = {
    itemType: "suggestion", suggestionId: staleSuggestion.id, taskId: stale.id,
    expectedVersion: stale.version, action: "skip", idempotencyKey: "cleanup-skip-01",
  };
  assert.deepEqual(core.recordCleanupAction(skip), core.recordCleanupAction(skip));
  assert.equal(core.cleanup().suggestions.some(item => item.taskId === stale.id), false);
  assert.equal(core.read("task", stale.id).version, stale.version);
  assert.ok(core.store.snapshot().state.cleanupDismissals[stale.id].cooldownUntil);

  const duplicateA = create("task", { title: "Prepare vendor report" });
  const duplicateB = create("task", { title: "Prepare vendor report" });
  const duplicate = core.cleanup().suggestions.find(item => item.taskId === duplicateB.id && item.type === "duplicate");
  assert.ok(duplicate);
  core.recordCleanupAction({
    itemType: "suggestion", suggestionId: duplicate.id, taskId: duplicateB.id,
    expectedVersion: duplicateB.version, action: "complete", idempotencyKey: "cleanup-complete-1",
  });
  assert.ok(core.read("task", duplicateB.id).completedAt);
  assert.equal(core.read("task", duplicateA.id).completedAt, null);
});

test("weekly review records both project drift actions and explicit project archive confirmation", t => {
  const { core, create, setNow } = setup(t);
  const addTaskProject = create("project", { name: "Needs a task" });
  const archiveProject = create("project", { name: "Ready to archive" });
  create("task", { title: "Old task A", projectId: addTaskProject.id });
  create("task", { title: "Old task B", projectId: archiveProject.id });
  setNow("2026-10-28T15:00:00Z");
  const session = core.startReview("project-review-start");
  assert.ok(session.projectIds.includes(addTaskProject.id));
  assert.ok(session.projectIds.includes(archiveProject.id));

  const addDecision = {
    sessionId: session.id, projectId: addTaskProject.id,
    expectedVersion: addTaskProject.version, action: "project_add_task",
    idempotencyKey: "project-add-task-01",
  };
  core.recordProjectReviewAction(addDecision);
  const newTask = create("task", { title: "First next step", projectId: addTaskProject.id });
  assert.equal(newTask.projectId, addTaskProject.id);

  const archiveDecision = {
    sessionId: session.id, projectId: archiveProject.id,
    expectedVersion: archiveProject.version, action: "project_archive",
    idempotencyKey: "project-archive-01",
  };
  assert.throws(() => core.recordProjectReviewAction(archiveDecision), /confirmation/);
  core.recordProjectReviewAction({ ...archiveDecision, confirmed: true });
  assert.equal(core.read("project", archiveProject.id).isArchived, true);
  assert.deepEqual(core.store.snapshot().state.review.decisions.map(decision => decision.action), [
    "project_add_task", "project_archive",
  ]);
  assert.ok(core.finishReview(session.id, "project-review-finish").completedAt);
});

test("focus starts explicitly, persists and does not complete a task on exit", t => {
  const { core, create, setNow } = setup(t);
  const task = create();
  assert.equal(core.store.snapshot().state.focus, undefined);
  core.focus(); assert.equal(core.store.snapshot().state.focus, undefined);
  const session = core.focusSession("start", "focus-start", task.id);
  assert.throws(() => core.focusSession("start", "focus-start-2", task.id), /End/);
  setNow("2026-10-07T15:05:00Z");
  const end = core.focusSession("end", "focus-end-1");
  assert.equal(end.durationSeconds, 300);
  assert.equal(core.read("task", task.id).completedAt, null);
  assert.equal(core.store.snapshot().state[`focus_session.${session.id}`].durationSeconds, 300);
});

test("export/import preserves metadata, reminders, dates and state; rejects duplicates/orphans", t => {
  const { core, create } = setup(t);
  const task = create("task", { title: "Reminder", reminders: [{ id: "r1", time: "2026-10-08T09:00:00-05:00", repeatInterval: "weekdays" }] });
  core.focusSession("start", "focus-start", task.id);
  const snapshot = core.exportSnapshot();
  snapshot.records.task[0].behaviorMetadata = { preserved: true };
  const target = new SQLiteStore(":memory:"); t.after(() => target.close());
  const other = new ClearTask(target);
  other.importSnapshot(snapshot);
  assert.equal(other.read("task", task.id).reminders[0].repeatInterval, "weekdays");
  assert.deepEqual(other.read("task", task.id).behaviorMetadata, { preserved: true });
  assert.equal(other.store.snapshot().state.focus.taskId, task.id);
  assert.throws(() => other.importSnapshot(snapshot), /empty destination/);
  const duplicate = structuredClone(snapshot); duplicate.records.task.push(duplicate.records.task[0]);
  assert.throws(() => other.validateImport(duplicate), /Duplicate/);
  const orphan = structuredClone(snapshot); orphan.records.task[0].parentId = "missing";
  assert.throws(() => other.validateImport(orphan), /Invalid task reference/);
  const invalid = structuredClone(snapshot); invalid.state.review = { id: "fake" };
  assert.throws(() => other.validateImport(invalid));
});

test("reopen a database preserves records, sessions, approvals, and retry results", t => {
  const dir = mkdtempSync(join(tmpdir(), "cleartask-restart-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.sqlite");
  const first = new SQLiteStore(path), core = new ClearTask(first);
  const request = { operation: { entity: "task", action: "create", data: { title: "Persist" } }, idempotencyKey: "persist-create" };
  const result = core.mutate(request), task = core.read("task", result.createdIds[0].id);
  core.focusSession("start", "persist-focus", task.id);
  const plan = core.preview({ operations: [{ entity: "task", action: "delete", id: task.id, expectedVersion: task.version }], idempotencyKey: "persist-delete" });
  core.approve(plan.id, plan.digest); first.close();
  const second = new SQLiteStore(path); t.after(() => second.close());
  const restored = new ClearTask(second);
  assert.deepEqual(restored.mutate(request), result);
  assert.equal(second.snapshot().state.focus.taskId, task.id);
  assert.ok(second.plan(plan.id).approvedAt);
  assert.ok(restored.apply(plan.id));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("prepared Firestore conversion validates ownership and timestamps without Firebase", () => {
  const input = { format: "cleartask-firestore-export", userId: "owner-placeholder",
    spaces: [], projects: [], tasks: [{ id: "legacy-task", userId: "owner-placeholder", title: "Preserved", createdAt: { seconds: 1791385200, nanoseconds: 123000000 }, reminders: [], recurrence: { type: "weekly", nextOccurrence: { seconds: 1791990000, nanoseconds: 0 } } }] };
  const output = convertFirestoreExport(input);
  assert.equal(output.records.task[0].createdAt, new Date(1791385200123).toISOString());
  assert.equal(output.records.task[0].recurrence.type, "weekly");
  assert.equal(output.records.task[0].userId, undefined);
  assert.equal(input.tasks[0].createdAt.seconds, 1791385200);
  input.tasks[0].userId = "another-owner";
  assert.throws(() => convertFirestoreExport(input), /Mixed-owner/);
});
