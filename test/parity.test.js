import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";
import { focusSelection, reviewSelection } from "../src/behavior.js";
import { analyzeTasksForCleanup, computeDetailedCleanupScores } from "../src/cleanup.js";
import { computeWeeklyDiagnostics } from "../src/weekly-diagnostics.js";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = path => readFileSync(`${root}${path}`, "utf8");
const hasApp = existsSync(`${root}backend/behavior_engine/focusScoring.ts`);
function loadTS(path, imports) {
  const ts = require("typescript");
  const module = { exports: {} };
  const code = ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected platform import: ${name}`);
    return imports[name];
  }, __DEV__: false, Date, Set, Map, console });
  return module.exports;
}
const normalize = value => JSON.parse(JSON.stringify(value));

test("focus rankings and breakdowns match current app for many inputs and caps", { skip: !hasApp }, () => {
  const now = new Date("2026-10-07T15:00:00Z");
  const original = loadTS("backend/behavior_engine/focusScoring.ts", { "@/types/task": { isTaskSoftDeleted: t => Boolean(t.deletedAt) } });
  for (let batch = 0; batch < 8; batch++) {
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      id: `task-${batch}-${i}`, title: `Task ${i}`, spaceId: i % 2 ? "a" : "b",
      createdAt: new Date(now.getTime() - (i + batch) * 86400000),
      lastActivityAt: new Date(now.getTime() - i * 3600000),
      dueDate: i % 3 === 0 ? new Date(now.getTime() + (i % 7 - 3) * 86400000) : null,
      important: i % 5 === 0, deferralCount: i % 4,
      completedAt: i % 13 === 0 ? now : null, deletedAt: i % 17 === 0 ? now : null,
      reminders: i % 9 === 0 ? [{ time: new Date(now.getTime() - 3600000), handled: false, suppressed: false }] : [],
    }));
    const active = new Set(tasks.filter(t => t.reminders.length).map(t => t.id));
    for (const spaceId of [undefined, "a"]) for (const limit of [1, 3, 5, 10]) {
      const expected = original.scoreFocusTasks(tasks, active, now, { spaceId, maxTasks: limit });
      const actual = focusSelection(tasks, now, { spaceId, limit });
      assert.deepEqual(actual.items.map(t => t.task.id), Array.from(expected.rankedTasks.slice(0, limit), t => t.id));
      assert.deepEqual(normalize(actual.items.map(t => ({ taskId: t.task.id, score: t.score, scoreBreakdown: t.scoreBreakdown }))), normalize(expected.scoredTasks.slice(0, limit)));
    }
  }
});

test("weekly-review selection matches current app with injected eligibility clock", { skip: !hasApp }, () => {
  const now = new Date("2026-10-07T15:00:00Z");
  const helpers = {
    isTaskCompleted: t => Boolean(t.completedAt), isTaskSoftDeleted: t => Boolean(t.deletedAt),
    // App helper uses the wall clock; inject now in this reference adapter so
    // historical fixtures measure intended calendar behavior, not test date.
    isTaskHidden: t => Boolean(t.nextVisibleAt && t.nextVisibleAt > now),
  };
  const backlog = loadTS("utils/backlogHelpers.ts", {});
  const week = loadTS("utils/weekHelpers.ts", {});
  const original = loadTS("services/weeklyReviewV0.ts", { "../types/task": helpers, "../utils/backlogHelpers": backlog, "../utils/weekHelpers": week });
  const tasks = Array.from({ length: 80 }, (_, i) => ({
    id: `task-${i}`, title: `Task ${i}`, projectId: `project-${i % 6}`,
    createdAt: new Date(now.getTime() - (i + 1) * 86400000),
    lastActivityAt: new Date(now.getTime() - (i + 1) * 86400000),
    dueDate: i % 3 ? new Date(now.getTime() + (i % 16 - 6) * 86400000) : null,
    reviewedAt: i % 7 === 0 ? new Date("2026-10-06T09:00:00Z") : null,
    nextVisibleAt: i % 11 === 0 ? new Date("2026-11-01T09:00:00Z") : null,
    completedAt: i % 13 === 0 ? now : null, deletedAt: i % 17 === 0 ? now : null,
    parentId: i % 19 === 0 ? "parent" : null,
  }));
  const projects = Array.from({ length: 6 }, (_, i) => ({ id: `project-${i}`, name: `Project ${i}`, isArchived: i === 5 }));
  const expected = original.computeV0ReviewSelection(tasks, projects, now);
  const actual = reviewSelection(tasks, projects, now);
  const ids = (rows, wrapped = false) => Array.from(rows, row => (wrapped ? row.task : row).id);
  assert.deepEqual(ids(actual.overdue), ids(expected.overdue, true));
  assert.deepEqual(ids(actual.upcoming), ids(expected.upcoming, true));
  assert.deepEqual(ids(actual.backlogCandidates), ids(expected.backlogCandidates));
  assert.deepEqual(actual.noMovementProjects.map(p => p.project.id), Array.from(expected.noMovementProjects, p => p.project.id));
});

test("active cleanup suggestions and detailed scorecards match current app", { skip: !hasApp }, () => {
  const now = new Date("2026-10-07T15:00:00Z");
  const helpers = {
    isTaskCompleted: task => Boolean(task.completedAt),
    isTaskSoftDeleted: task => Boolean(task.deletedAt),
    isTaskHidden: task => Boolean(task.nextVisibleAt && new Date(task.nextVisibleAt).getTime() > now.getTime()),
  };
  const original = loadTS("services/aiCleanup.ts", { "@/types/task": helpers });
  const ago = days => new Date(now.getTime() - days * 86400000);
  const task = (id, title, extra = {}) => ({
    id, title, createdAt: ago(2), lastActivityAt: ago(2), dueDate: null,
    important: false, projectId: null, spaceId: null, parentId: null,
    completedAt: null, deletedAt: null, nextVisibleAt: null, deferralCount: 0,
    reminders: [], ...extra,
  });
  const tasks = [
    task("stale", "Review annual plan", { createdAt: ago(45), lastActivityAt: ago(45), staleness_score: 78, intent_confidence: 0.4, deferralCount: 3 }),
    task("dup-a", "Review vendor contract", { createdAt: ago(2), projectId: "p", spaceId: "s" }),
    task("dup-b", "Review vendor contract", { createdAt: ago(1), projectId: "p", spaceId: "s" }),
    task("vague", "Fix", { createdAt: ago(3), lastActivityAt: ago(3) }),
    ...Array.from({ length: 11 }, (_, i) => task(`dense-${i}`, `Review launch item ${i}`, {
      createdAt: ago(i + 1), projectId: "dense", spaceId: "s",
    })),
    task("conflict-a", "Prepare budget", { projectId: "p", spaceId: "s" }),
    task("conflict-b", "Prepare budget", { projectId: "p2", spaceId: "s2" }),
    task("done", "Completed", { completedAt: ago(1) }),
    task("deleted", "Deleted", { deletedAt: ago(1) }),
    task("hidden", "Hidden", { nextVisibleAt: new Date(now.getTime() + 86400000) }),
    task("parent", "Parent complete", { completedAt: ago(20), createdAt: ago(40), lastActivityAt: ago(40) }),
    task("child", "Open old subtask", { parentId: "parent", createdAt: ago(40), lastActivityAt: ago(40) }),
  ];
  const projects = [{ id: "p", name: "Plan" }, { id: "dense", name: "Dense project" }, { id: "p2", name: "Other plan" }];
  const expected = original.analyzeTasksForCleanup(tasks, projects, now);
  const actual = analyzeTasksForCleanup(tasks, projects, now);
  assert.deepEqual(normalize(actual), normalize(expected));
  assert.deepEqual(
    normalize(computeDetailedCleanupScores(tasks, now)),
    normalize(original.computeDetailedCleanupScores(tasks, now)),
  );
});

test("weekly diagnostics match the active app for event windows and backlog snapshots", { skip: !hasApp }, () => {
  const now = new Date("2026-10-09T18:00:00Z");
  const original = loadTS("services/weeklyDiagnostics.ts", {});
  const events = [
    { eventType: "task_completed", timestamp: new Date(now.getTime() - 1 * 86400000) },
    { eventType: "task_completed", timestamp: new Date(now.getTime() - 8 * 86400000) },
    { eventType: "task_completed", timestamp: new Date(now.getTime() - 30 * 86400000) },
    { eventType: "task_rescheduled", timestamp: new Date(now.getTime() - 5 * 86400000) },
    { eventType: "task_rescheduled", timestamp: new Date(now.getTime() - 12 * 86400000) },
  ];
  const snapshots = [
    { capturedAt: new Date(now.getTime() - 31 * 86400000), openTaskCount: 12 },
    { capturedAt: new Date(now.getTime() - 7 * 86400000), openTaskCount: 14 },
    { capturedAt: new Date(now.getTime() - 1 * 86400000), openTaskCount: 16 },
  ];
  assert.deepEqual(
    normalize(computeWeeklyDiagnostics(events, snapshots, now)),
    normalize(original.computeWeeklyDiagnostics(events, snapshots, now)),
  );
});
