import test from "node:test";
import assert from "node:assert/strict";
import { focusSelection, reviewSelection, getReviewCycleStart } from "../src/behavior.js";

const now = new Date("2026-10-07T15:00:00Z");
const task = (id, fields = {}) => ({ id, title: id, createdAt: "2026-10-01T15:00:00Z", lastActivityAt: "2026-10-01T15:00:00Z", completedAt: null, deletedAt: null, deferralCount: 0, important: false, ...fields });

test("focus_v3 scores and exclusions; bounded fallback ordering", () => {
  const tasks = [
    task("overdue", { dueDate: "2026-10-06T09:00:00Z", important: true, deferralCount: 2 }),
    task("today", { dueDate: "2026-10-07T09:00:00Z" }),
    task("stale", { createdAt: "2026-09-01T09:00:00Z" }),
    task("fallback"), task("done", { completedAt: "2026-10-07T09:00:00Z" }),
    task("hidden", { nextVisibleAt: "2026-11-01T09:00:00Z", important: true }),
    task("child", { parentId: "overdue", important: true }),
  ];
  const result = focusSelection(tasks, now, { limit: 5 });
  assert.equal(result.version, "focus_v3");
  assert.deepEqual(result.items.map(i => i.task.id), ["overdue", "today", "stale", "fallback"]);
  assert.equal(result.items[0].score, 165.15);
  assert.equal(focusSelection(tasks, now, { limit: 1 }).items.length, 1);
});

test("space focus is strict, excludes reminder-only tasks and uses urgency ordering", () => {
  const tasks = [
    task("important", { spaceId: "a", important: true }),
    task("overdue", { spaceId: "a", dueDate: "2026-10-06T09:00:00Z" }),
    task("reminder-only", { spaceId: "a", reminders: [{ time: "2026-10-01T09:00:00Z" }] }),
    task("outside", { spaceId: "b", important: true }),
  ];
  assert.deepEqual(focusSelection(tasks, now, { spaceId: "a" }).items.map(i => i.task.id), ["overdue", "important"]);
});

test("review cycle is Monday 06:00 local, including before-boundary and DST dates", () => {
  const before = new Date(2026, 9, 5, 5, 59);
  const after = new Date(2026, 9, 5, 6, 0);
  assert.equal(getReviewCycleStart(before).getDate(), 28);
  assert.equal(getReviewCycleStart(after).getDate(), 5);
  const aroundDST = new Date(2026, 10, 2, 9);
  assert.equal(getReviewCycleStart(aroundDST).getHours(), 6);
  assert.equal(getReviewCycleStart(aroundDST).getDay(), 1);
});

test("reviewed overdue stays hidden; reviewed upcoming resurfaces only when overdue", () => {
  const tasks = [
    task("kept", { dueDate: "2026-10-04T09:00:00Z", reviewedAt: "2026-10-06T09:00:00Z" }),
    task("escalated", { dueDate: "2026-10-06T12:00:00Z", reviewedAt: "2026-10-06T09:00:00Z" }),
    task("upcoming", { dueDate: "2026-10-09T09:00:00Z", reviewedAt: "2026-10-06T09:00:00Z" }),
  ];
  const result = reviewSelection(tasks, [], now);
  assert.deepEqual(result.overdue.map(t => t.id), ["escalated"]);
  assert.equal(result.upcoming.length, 0);
});

test("review caps and project drift follow recent completions/activity/deadlines", () => {
  const projects = ["stale", "recent", "completed", "deadline", "archived"].map(id => ({ id, name: id, isArchived: id === "archived" }));
  const tasks = projects.map(p => task(p.id, { projectId: p.id, lastActivityAt: "2026-09-01T09:00:00Z", createdAt: "2026-09-01T09:00:00Z" }));
  tasks.find(t => t.id === "recent").lastActivityAt = "2026-10-06T09:00:00Z";
  tasks.push(task("done", { projectId: "completed", completedAt: "2026-10-06T09:00:00Z" }));
  tasks.find(t => t.id === "deadline").dueDate = "2026-10-08T09:00:00Z";
  for (let i = 0; i < 20; i++) tasks.push(task(`upcoming-${i}`, { dueDate: "2026-10-09T09:00:00Z" }));
  const result = reviewSelection(tasks, projects, now);
  assert.deepEqual(result.noMovementProjects.map(p => p.project.id), ["stale"]);
  assert.equal(result.upcoming.length, 12);
});
