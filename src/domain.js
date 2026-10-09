import { createHash, randomUUID } from "node:crypto";
import {
  operation, mutation, previewInput, listInput, dataSchemas, snapshotSchema,
  cleanupActionInput, cleanupQueryInput, projectReviewInput,
} from "./schemas.js";
import { z } from "zod";
import { id as idSchema, timestamp } from "./schemas.js";
import { focusSelection, reviewSelection, FOCUS_MODEL_VERSION } from "./behavior.js";
import { analyzeTasksForCleanup, computeDetailedCleanupScores, CLEANUP_MODEL_VERSION } from "./cleanup.js";
import { computeWeeklyDiagnostics } from "./weekly-diagnostics.js";

const clone = value => structuredClone(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const live = record => record && !record.deletedAt;

export function validateRelationships(records) {
  for (const kind of ["task", "project", "space"]) {
    if (new Set(records[kind].map(r => r.id)).size !== records[kind].length) throw new Error(`Duplicate ${kind} ids.`);
  }
  const maps = Object.fromEntries(Object.entries(records).map(([kind, rows]) => [kind, new Map(rows.map(r => [r.id, r]))]));
  const reference = (kind, id, owner) => {
    if (!id) return null;
    const record = maps[kind].get(id);
    if (!record || (live(owner) && !live(record))) throw new Error(`Invalid ${kind} reference: ${id}`);
    return record;
  };
  for (const project of records.project) reference("space", project.spaceId, project);
  for (const task of records.task) {
    const parent = reference("task", task.parentId, task);
    if (parent && (parent.parentId || parent.id === task.id)) throw new Error("Only one subtask level is allowed.");
    if (parent && ((task.spaceId ?? null) !== (parent.spaceId ?? null) || (task.projectId ?? null) !== (parent.projectId ?? null))) throw new Error("Subtasks must inherit the parent's space and project.");
    reference("space", task.spaceId, task);
    const project = reference("project", task.projectId, task);
    if (project && (task.spaceId ?? null) !== (project.spaceId ?? null)) throw new Error("Task space must match its project's space.");
  }
}

function getRecord(records, kind, id) {
  const found = records[kind].find(r => r.id === id);
  if (!found) throw new Error(`${kind} not found: ${id}`);
  return found;
}

function syncCompletion(records, parentId, now) {
  if (!parentId) return;
  const parent = getRecord(records, "task", parentId);
  if (!live(parent)) return;
  const children = records.task.filter(t => t.parentId === parentId && live(t));
  if (!children.length) return;
  const allDone = children.every(t => t.completedAt);
  if (allDone !== Boolean(parent.completedAt)) {
    parent.completedAt = allDone ? now : null;
    parent.lastActivityAt = now;
  }
}

function simulate(before, operations, now) {
  const records = clone(before);
  const createdIds = [];
  for (const op of operations) {
    const data = dataSchemas[op.entity].parse(op.data ?? {});
    if (op.action === "create") {
      const id = op.generatedId ?? randomUUID();
      const base = { id, version: 0, createdAt: now, lastActivityAt: now, deletedAt: null, deletionGroup: null, ...data };
      const record = op.entity === "task"
        ? { important: false, dueDate: null, projectId: null, spaceId: null, parentId: null, completedAt: null, nextVisibleAt: null, reviewedAt: null, deferralCount: 0, reminders: [], ...base }
        : { color: "#6B8F71", spaceId: null, isArchived: false, ...(op.entity === "space" ? { icon: "folder" } : {}), ...base };
      if (op.entity === "space") delete record.spaceId;
      if (op.entity === "task") {
        if (record.parentId) {
          const parent = getRecord(records, "task", record.parentId);
          if (!live(parent) || parent.parentId) throw new Error("Parent must be a live top-level task.");
          record.projectId = parent.projectId;
          record.spaceId = parent.spaceId;
        } else if (record.projectId) {
          const project = getRecord(records, "project", record.projectId);
          if (data.spaceId && data.spaceId !== project.spaceId) throw new Error("Task/project space mismatch.");
          record.spaceId = project.spaceId ?? null;
        }
      }
      records[op.entity].push(record);
      if (op.entity === "task") syncCompletion(records, record.parentId, now);
      createdIds.push({ entity: op.entity, id });
      continue;
    }
    const record = getRecord(records, op.entity, op.id);
    if (record.version !== op.expectedVersion) throw new Error("Record changed. Read the latest version and retry.");
    if (!live(record) && op.action !== "restore") throw new Error("Record is deleted; restore it before editing.");
    if (op.action === "restore" && live(record)) throw new Error("Record is not deleted.");
    record.lastActivityAt = now;
    if (op.action === "update") {
      if (op.entity === "task" && Object.hasOwn(data, "parentId")) throw new Error("Reparenting is not supported; create a subtask under its intended parent.");
      if (op.entity === "task" && record.parentId && ("spaceId" in data || "projectId" in data)) throw new Error("Move the parent, not its subtask.");
      Object.assign(record, data);
      if (op.entity === "task" && record.projectId) {
        const project = getRecord(records, "project", record.projectId);
        if ("spaceId" in data && data.spaceId !== (project.spaceId ?? null)) throw new Error("Task/project space mismatch.");
        record.spaceId = project.spaceId ?? null;
      }
      if (op.entity === "project" && "spaceId" in data) {
        for (const task of records.task.filter(t => t.projectId === record.id)) { task.spaceId = record.spaceId; task.lastActivityAt = now; }
      }
      if (op.entity === "task" && !record.parentId) {
        for (const child of records.task.filter(t => t.parentId === record.id)) {
          child.spaceId = record.spaceId; child.projectId = record.projectId; child.lastActivityAt = now;
        }
      }
    } else if (["complete", "reopen"].includes(op.action) || (op.action === "archive" && op.entity === "task")) {
      const completedAt = op.action === "reopen" ? null : now;
      record.completedAt = completedAt;
      if (!record.parentId) {
        for (const child of records.task.filter(t => t.parentId === record.id && live(t))) { child.completedAt = completedAt; child.lastActivityAt = now; }
      }
      syncCompletion(records, record.parentId, now);
    } else if (op.action === "defer") {
      if (new Date(op.until) <= new Date(now)) throw new Error("Defer time must be in the future.");
      record.nextVisibleAt = op.until;
      record.deferralCount += 1;
    } else if (["archive", "unarchive"].includes(op.action)) {
      record.isArchived = op.action === "archive";
    } else if (op.action === "delete") {
      const group = randomUUID();
      record.deletedAt = now; record.deletionGroup = group;
      if (op.entity === "task") {
        for (const child of records.task.filter(t => t.parentId === record.id && live(t))) {
          child.deletedAt = now; child.deletionGroup = group; child.lastActivityAt = now;
        }
        syncCompletion(records, record.parentId, now);
      } else if (op.entity === "project") {
        for (const task of records.task.filter(t => t.projectId === record.id)) { task.projectId = null; task.lastActivityAt = now; }
      } else {
        for (const project of records.project.filter(p => p.spaceId === record.id)) { project.spaceId = null; project.lastActivityAt = now; }
        for (const task of records.task.filter(t => t.spaceId === record.id)) { task.spaceId = null; task.lastActivityAt = now; }
      }
    } else if (op.action === "restore") {
      const group = record.deletionGroup;
      record.deletedAt = null; record.deletionGroup = null;
      if (op.entity === "task") {
        if (group && !record.parentId) {
          for (const child of records.task.filter(t => t.parentId === record.id && t.deletionGroup === group)) {
            child.deletedAt = null; child.deletionGroup = null; child.lastActivityAt = now;
          }
        }
        syncCompletion(records, record.parentId, now);
      }
    }
  }
  validateRelationships(records);
  const changes = [];
  for (const kind of ["task", "project", "space"]) {
    const originals = new Map(before[kind].map(r => [r.id, r]));
    for (const record of records[kind]) {
      const previous = originals.get(record.id) ?? null;
      if (digest(previous) !== digest(record)) {
        record.version = (previous?.version ?? 0) + 1;
        changes.push({ entity: kind, id: record.id, before: previous, after: record });
      }
    }
  }
  return { changes, createdIds };
}

export class ClearTask {
  constructor(store, { clock = () => new Date() } = {}) { this.store = store; this.clock = clock; }
  now() { return this.clock().toISOString(); }
  read(kind, id) {
    const { records } = this.store.snapshot();
    return this.decorate(kind, getRecord(records, kind, id), records);
  }
  decorate(kind, record, records) {
    const now = this.clock().getTime();
    if (kind === "task") return { ...record, subtaskCount: records.task.filter(t => t.parentId === record.id && live(t)).length };
    if (kind === "space") return { ...record, projectCount: records.project.filter(p => p.spaceId === record.id && live(p)).length };
    const tasks = records.task.filter(t => t.projectId === record.id && live(t));
    return { ...record, taskCount: tasks.length, openTaskCount: tasks.filter(t => !t.completedAt).length,
      taskCreated14dCount: tasks.filter(t => new Date(t.createdAt).getTime() >= now - 14 * 86400000).length,
      taskCompleted14dCount: tasks.filter(t => t.completedAt && new Date(t.completedAt).getTime() >= now - 14 * 86400000).length,
      staleTaskCount: tasks.filter(t => !t.completedAt && now - new Date(t.lastActivityAt || t.createdAt).getTime() > 14 * 86400000).length };
  }
  list(input) {
    const args = listInput.parse(input);
    const { records } = this.store.snapshot();
    const now = this.clock();
    const result = records[args.entity].filter(r => {
      if (args.status === "deleted") { if (!r.deletedAt) return false; }
      else if (args.status !== "all") {
        if (r.deletedAt) return false;
        if (args.entity === "task") {
          const completed = Boolean(r.completedAt);
          const old = completed && now.getTime() - new Date(r.completedAt).getTime() > 30 * 86400000;
          if (args.status === "active" && (completed || (r.nextVisibleAt && new Date(r.nextVisibleAt) > now))) return false;
          if (args.status === "completed" && !completed) return false;
          if (args.status === "archived" && !old) return false;
        } else if (args.status === "archived" ? !r.isArchived : args.status === "active" && r.isArchived) return false;
      }
      if (args.projectId && r.projectId !== args.projectId) return false;
      if (args.spaceId && r.spaceId !== args.spaceId) return false;
      if (args.parentId && r.parentId !== args.parentId) return false;
      return !args.query || `${r.title ?? r.name} ${r.description ?? ""}`.toLowerCase().includes(args.query.toLowerCase());
    });
    return { items: result.slice(args.offset, args.offset + args.limit).map(r => this.decorate(args.entity, r, records)),
      total: result.length, nextOffset: args.offset + args.limit < result.length ? args.offset + args.limit : null };
  }
  log(operation, changes, requestKey, at) {
    this.store.event({ namespace: "mcp_v1", operation, changes, requestKey, timestamp: at,
      behaviorVersions: { focus: FOCUS_MODEL_VERSION, review: "weekly_review_v0", cleanup: CLEANUP_MODEL_VERSION } });
  }
  commit(simulation, requestKey, at, operations = []) {
    for (const change of simulation.changes) this.store.put(change.entity, change.after);
    if (simulation.changes.length) this.store.bump();
    this.log("mutation", simulation.changes, requestKey, at);
    for (const change of simulation.changes) {
      if (change.entity !== "task" || !change.before) continue;
      if (!change.before.completedAt && change.after.completedAt) {
        this.log("task_completed", [change], requestKey, at);
      }
      if (digest(change.before.dueDate ?? null) !== digest(change.after.dueDate ?? null)) {
        this.log("task_rescheduled", [change], requestKey, at);
      }
    }
    for (const op of operations.filter(item => item.entity === "task" && item.action === "defer")) {
      const change = simulation.changes.find(item => item.entity === "task" && item.id === op.id);
      if (change) this.log("task_rescheduled", [change], requestKey, at);
    }
    return { ...simulation, revision: this.store.revision() };
  }
  mutate(input) {
    const args = mutation.parse(input);
    const hash = digest(args.operation);
    return this.store.transaction(() => {
      const prior = this.store.request(args.idempotencyKey, hash);
      if (prior) return prior;
      if (args.operation.action === "delete") throw new Error("Deletion requires preview_changes and local owner approval.");
      const at = this.now();
      const result = simulate(this.store.snapshot().records, [args.operation], at);
      if (args.operation.action === "restore" && result.changes.length > 1) throw new Error("Family restoration requires preview_changes and local owner approval.");
      const committed = this.commit(result, args.idempotencyKey, at, [args.operation]);
      this.store.remember(args.idempotencyKey, hash, committed);
      return committed;
    });
  }
  preview(input) {
    const args = previewInput.parse(input);
    return this.store.transaction(() => {
      const result = this.store.request(args.idempotencyKey, digest(args.operations));
      if (result) throw new Error("This request was already applied; use apply_changes with its original plan id.");
      const operations = args.operations.map(op => ({ ...op, ...(op.action === "create" ? { generatedId: randomUUID() } : {}) }));
      const at = this.now();
      const plan = { id: randomUUID(), operations, idempotencyKey: args.idempotencyKey, revision: this.store.revision(),
        createdAt: at, expiresAt: new Date(this.clock().getTime() + 15 * 60000).toISOString(),
        ...simulate(this.store.snapshot().records, operations, at), approvedAt: null, appliedAt: null };
      plan.digest = digest({ operations, changes: plan.changes, revision: plan.revision, expiresAt: plan.expiresAt });
      this.store.savePlan(plan);
      return { ...plan, approvalInstructions: `Owner: inspect locally with cleartask-mcp plan ${plan.id}, then approve ${plan.id} --digest ${plan.digest}. MCP has no approval tool.` };
    });
  }
  approve(id, expectedDigest) {
    return this.store.transaction(() => {
      const plan = this.store.plan(id);
      this.checkPlan(plan);
      if (plan.digest !== expectedDigest) throw new Error("Digest does not match the inspected plan.");
      plan.approvedAt = this.now();
      this.store.savePlan(plan);
      this.log("approval", [], plan.idempotencyKey, plan.approvedAt);
      return { id: plan.id, approvedAt: plan.approvedAt };
    });
  }
  checkPlan(plan) {
    if (plan.appliedAt) throw new Error("Plan was already consumed.");
    if (new Date(plan.expiresAt) <= this.clock()) throw new Error("Plan expired. Create a new preview.");
    if (plan.revision !== this.store.revision()) throw new Error("Database changed since preview. Create a new preview.");
    if (plan.digest !== digest({ operations: plan.operations, changes: plan.changes, revision: plan.revision, expiresAt: plan.expiresAt })) throw new Error("Plan integrity check failed.");
  }
  apply(id) {
    return this.store.transaction(() => {
      const plan = this.store.plan(id);
      const hash = digest(plan.operations.map(({ generatedId, ...op }) => op));
      const prior = this.store.request(plan.idempotencyKey, hash);
      if (prior) return prior;
      this.checkPlan(plan);
      if (!plan.approvedAt) throw new Error("The local owner has not approved this plan.");
      // Commit the exact inspected changes, not a new simulation with new dates.
      const result = this.commit({ changes: plan.changes, createdIds: plan.createdIds }, plan.idempotencyKey, this.now(), plan.operations);
      plan.appliedAt = this.now(); this.store.savePlan(plan);
      this.store.remember(plan.idempotencyKey, hash, result);
      return result;
    });
  }
  focus(args = {}) {
    const { records } = this.store.snapshot();
    return focusSelection(records.task, this.clock(), args);
  }
  cleanup(input = {}) {
    const args = cleanupQueryInput.parse(input);
    const { records, state } = this.store.snapshot();
    const now = this.clock();
    const analysis = analyzeTasksForCleanup(records.task, records.project, now);
    const dismissals = state.cleanupDismissals ?? {};
    const suggestions = analysis.suggestions.filter(item => {
      const dismissal = dismissals[item.taskId];
      if (!dismissal) return true;
      if (dismissal.dismissedAt) return false;
      return !dismissal.cooldownUntil || new Date(dismissal.cooldownUntil) <= now;
    });
    const detailedScores = computeDetailedCleanupScores(records.task, now);
    return {
      modelVersion: analysis.modelVersion,
      analysisDate: analysis.analysisDate,
      totalTasksAnalyzed: analysis.totalTasksAnalyzed,
      suggestionCount: suggestions.length,
      suggestions: suggestions.slice(args.suggestionOffset, args.suggestionOffset + args.limit),
      nextSuggestionOffset: args.suggestionOffset + args.limit < suggestions.length ? args.suggestionOffset + args.limit : null,
      detailedScoreCount: detailedScores.length,
      detailedScores: detailedScores.slice(args.scoreOffset, args.scoreOffset + args.scoreLimit),
      nextScoreOffset: args.scoreOffset + args.scoreLimit < detailedScores.length ? args.scoreOffset + args.scoreLimit : null,
    };
  }
  weeklyDiagnostics() {
    const { state } = this.store.snapshot();
    const since = new Date(this.clock().getTime() - 30 * 86400000).toISOString();
    const history = this.store.db.prepare(
      "SELECT json FROM events WHERE json_extract(json, '$.operation') IN (?, ?) AND json_extract(json, '$.timestamp') >= ? ORDER BY sequence",
    ).all("task_completed", "task_rescheduled", since)
      .map(row => JSON.parse(row.json));
    const events = history.map(event => ({ eventType: event.operation, timestamp: event.timestamp }));
    return computeWeeklyDiagnostics(events, state.weeklyDiagnosticSnapshots ?? [], this.clock());
  }
  recordCleanupAction(input) {
    const args = cleanupActionInput.parse(input);
    const hash = digest(args);
    return this.store.transaction(() => {
      const prior = this.store.request(args.idempotencyKey, hash);
      if (prior) return prior;
      const { records, state } = this.store.snapshot();
      const task = getRecord(records, "task", args.taskId);
      if (task.version !== args.expectedVersion) throw new Error("Record changed. Read its latest version.");
      const now = this.clock();
      const analysis = analyzeTasksForCleanup(records.task, records.project, now);
      const dismissal = (state.cleanupDismissals ?? {})[task.id];
      if (dismissal?.dismissedAt || (dismissal?.cooldownUntil && new Date(dismissal.cooldownUntil) > now)) {
        throw new Error("Cleanup suggestion is currently dismissed or on cooldown.");
      }
      if (args.itemType === "suggestion") {
        const suggestion = analysis.suggestions.find(item => item.id === args.suggestionId && item.taskId === task.id);
        if (!suggestion) throw new Error("Cleanup suggestion is no longer current.");
        const allowedAction = { hide_until_later: "defer", archive: "complete", rewrite_title: "rewrite_title" }[suggestion.action];
        if (args.action !== "skip" && args.action !== allowedAction) throw new Error("Action does not match the current cleanup suggestion.");
      } else {
        const score = computeDetailedCleanupScores(records.task, now).find(item =>
          item.taskId === task.id && item.reason === args.reason && (item.relatedTaskId ?? undefined) === args.relatedTaskId);
        if (!score) throw new Error("Cleanup score is no longer current.");
      }
      const at = now.toISOString();
      if (args.action === "skip") {
        const cleanupDismissals = { ...(state.cleanupDismissals ?? {}) };
        cleanupDismissals[task.id] = { cooldownUntil: new Date(now.getTime() + 7 * 86400000).toISOString() };
        this.store.setState("cleanupDismissals", cleanupDismissals);
        this.store.bump();
        const result = { taskId: task.id, action: "skip", cooldownUntil: cleanupDismissals[task.id].cooldownUntil, revision: this.store.revision() };
        this.log("cleanup_skip", [], args.idempotencyKey, at);
        this.store.remember(args.idempotencyKey, hash, result);
        return result;
      }
      const operation = args.action === "defer"
        ? { entity: "task", action: "update", id: task.id, expectedVersion: task.version, data: { nextVisibleAt: args.until } }
        : args.action === "complete"
          ? { entity: "task", action: "complete", id: task.id, expectedVersion: task.version }
          : { entity: "task", action: "update", id: task.id, expectedVersion: task.version, data: { title: args.newTitle } };
      const result = simulate(records, [operation], at);
      const committed = this.commit(result, args.idempotencyKey, at, [operation]);
      this.log("cleanup_action", result.changes, args.idempotencyKey, at);
      const output = { ...committed, cleanupAction: args.action };
      this.store.remember(args.idempotencyKey, hash, output);
      return output;
    });
  }
  review(args = {}) {
    const { records } = this.store.snapshot();
    const selected = reviewSelection(records.task, records.project, this.clock());
    const offset = args.offset ?? 0, limit = args.limit ?? 30;
    return { ...selected, overdue: selected.overdue.slice(offset, offset + limit), overdueTotal: selected.overdue.length,
      nextOffset: offset + limit < selected.overdue.length ? offset + limit : null,
      openTaskCount: records.task.filter(task => !task.completedAt && !task.deletedAt).length,
      diagnostics: this.weeklyDiagnostics() };
  }
  localWrite(requestKey, input, fn) {
    const hash = digest(input);
    return this.store.transaction(() => {
      const prior = this.store.request(requestKey, hash);
      if (prior) return prior;
      const result = fn();
      this.store.bump();
      this.log(input.action, [], requestKey, this.now());
      this.store.remember(requestKey, hash, result);
      return result;
    });
  }
  startReview(requestKey) {
    return this.localWrite(requestKey, { action: "review_start" }, () => {
      const { records, state } = this.store.snapshot();
      if (state.review && !state.review.completedAt) return state.review;
      const selection = reviewSelection(records.task, records.project, this.clock());
      const session = { id: randomUUID(), startedAt: this.now(), completedAt: null, cycleStart: selection.cycleStart,
        taskIds: [...new Set([...selection.overdue, ...selection.upcoming, ...selection.backlogCandidates].map(t => t.id))],
        projectIds: selection.noMovementProjects.map(p => p.project.id), decisions: [] };
      this.store.setState("review", session);
      return session;
    });
  }
  recordReview(args) {
    return this.localWrite(args.idempotencyKey, { action: "review_decision", ...args }, () => {
      const { records, state } = this.store.snapshot();
      const session = state.review;
      if (!session || session.id !== args.sessionId || session.completedAt) throw new Error("No matching active review session.");
      if (args.entity !== "task") throw new Error("Use record_project_review_decision for project drift actions.");
      if (!session.taskIds.includes(args.id)) throw new Error("Record is not in this review session.");
      if (session.decisions.some(d => d.entity === "task" && d.id === args.id)) throw new Error("Record already reviewed in this session.");
      const record = getRecord(records, "task", args.id);
      if (record.version !== args.expectedVersion) throw new Error("Record changed. Read its latest version.");
      if (args.action === "archive" && !record.deletedAt) throw new Error("Soft-delete the task using an owner-approved delete plan first.");
      if (args.action !== "archive" && record.deletedAt) throw new Error("Cannot review a deleted record as kept.");
      const before = clone(record);
      if (args.action === "reschedule") {
        if (!args.dueDate) throw new Error("Reschedule requires dueDate.");
        record.dueDate = timestamp.parse(args.dueDate);
        record.lastActivityAt = this.now();
      } else if (args.dueDate) throw new Error("dueDate is only valid for reschedule.");
      record.reviewedAt = this.now();
      record.version += 1;
      this.store.put("task", record);
      this.log("weekly_review_action", [{ entity: "task", id: record.id, before, after: record }], args.idempotencyKey, this.now());
      if (args.action === "reschedule") {
        this.log("task_rescheduled", [{ entity: "task", id: record.id, before, after: record }], args.idempotencyKey, this.now());
      }
      session.decisions.push({ entity: "task", id: args.id, action: args.action, decidedAt: this.now() });
      this.store.setState("review", session);
      return { id: session.id, completedCount: session.decisions.length, totalCount: session.taskIds.length + session.projectIds.length };
    });
  }
  recordProjectReviewAction(input) {
    const args = projectReviewInput.parse(input);
    return this.localWrite(args.idempotencyKey, { action: "weekly_review_project_decision", ...args }, () => {
      const { records, state } = this.store.snapshot();
      const session = state.review;
      if (!session || session.id !== args.sessionId || session.completedAt) throw new Error("No matching active review session.");
      if (!session.projectIds.includes(args.projectId)) throw new Error("Project is not in this review session.");
      if (session.decisions.some(d => d.entity === "project" && d.id === args.projectId)) throw new Error("Project already reviewed in this session.");
      const project = getRecord(records, "project", args.projectId);
      if (project.version !== args.expectedVersion) throw new Error("Project changed. Read its latest version.");
      if (project.deletedAt) throw new Error("Cannot review a deleted project.");
      if (args.action === "project_archive" && project.isArchived) throw new Error("Project is already archived.");
      const before = clone(project);
      if (args.action === "project_archive") {
        project.isArchived = true;
        project.lastActivityAt = this.now();
        project.version += 1;
        this.store.put("project", project);
      }
      this.log("weekly_review_project_action", args.action === "project_archive"
        ? [{ entity: "project", id: project.id, before, after: project }] : [], args.idempotencyKey, this.now());
      session.decisions.push({ entity: "project", id: project.id, action: args.action, decidedAt: this.now() });
      this.store.setState("review", session);
      return { id: session.id, projectId: project.id, action: args.action,
        completedCount: session.decisions.length, totalCount: session.taskIds.length + session.projectIds.length };
    });
  }
  finishReview(sessionId, requestKey) {
    return this.localWrite(requestKey, { action: "review_finish", sessionId }, () => {
      const { records, state } = this.store.snapshot();
      if (!state.review || state.review.id !== sessionId || state.review.completedAt) throw new Error("No matching active review.");
      state.review.completedAt = this.now();
      this.store.setState("review", state.review);
      const completedAt = this.now();
      this.store.setState("lastReviewCompletedAt", completedAt);
      const snapshots = state.weeklyDiagnosticSnapshots ?? [];
      const lastSnapshot = snapshots.at(-1);
      if (!lastSnapshot || this.clock().getTime() - new Date(lastSnapshot.capturedAt).getTime() >= 6 * 86400000) {
        snapshots.push({
          capturedAt: completedAt,
          openTaskCount: records.task.filter(task => !task.completedAt && !task.deletedAt).length,
        });
        this.store.setState("weeklyDiagnosticSnapshots", snapshots.slice(-15));
      }
      return state.review;
    });
  }
  focusSession(action, requestKey, taskId) {
    return this.localWrite(requestKey, { action: `focus_${action}`, taskId: taskId ?? null }, () => {
      const { records, state } = this.store.snapshot();
      if (action === "start") {
        if (state.focus) throw new Error("End the current focus session first.");
        const task = getRecord(records, "task", taskId);
        if (!live(task) || task.completedAt || (task.nextVisibleAt && new Date(task.nextVisibleAt) > this.clock())) throw new Error("Task is not available for focus.");
        const session = { id: randomUUID(), taskId, taskTitle: task.title, startedAt: this.now() };
        this.store.setState("focus", session);
        return session;
      }
      if (!state.focus) throw new Error("No active focus session.");
      const session = { ...state.focus, endedAt: this.now(), durationSeconds: Math.max(0, Math.floor((this.clock() - new Date(state.focus.startedAt)) / 1000)) };
      this.store.setState(`focus_session.${session.id}`, session);
      this.store.setState("focus", null);
      return session;
    });
  }
  exportSnapshot() {
    return { format: "cleartask-mcp", formatVersion: 1, exportedAt: this.now(), ...this.store.snapshot(),
      history: this.store.db.prepare("SELECT json FROM events ORDER BY sequence").all().map(r => JSON.parse(r.json)) };
  }
  validateImport(input) {
    const snapshot = snapshotSchema.parse(input);
    validateRelationships(snapshot.records);
    const state = snapshot.state;
    const focusSchema = z.object({ id: idSchema, taskId: idSchema, taskTitle: z.string().max(200), startedAt: timestamp }).strict();
    const sessionSchema = focusSchema.extend({ endedAt: timestamp, durationSeconds: z.number().int().nonnegative() });
    const reviewSchema = z.object({
      id: idSchema, startedAt: timestamp, completedAt: timestamp.nullable(), cycleStart: timestamp,
      taskIds: z.array(idSchema).max(10000), projectIds: z.array(idSchema).max(10000),
      decisions: z.array(z.object({ entity: z.enum(["task", "project"]), id: idSchema,
        action: z.enum(["keep", "reschedule", "archive", "project_add_task", "project_review", "project_archive"]),
        decidedAt: timestamp }).strict()).max(20000),
    }).strict();
    const cleanupDismissalsSchema = z.record(idSchema, z.object({
      cooldownUntil: timestamp.optional(), dismissedAt: timestamp.optional(),
    }).strict());
    const diagnosticSnapshotsSchema = z.array(z.object({
      capturedAt: timestamp, openTaskCount: z.number().int().nonnegative(),
    }).strict()).max(15);
    for (const [name, value] of Object.entries(state)) {
      if (name === "focus") { if (value !== null) focusSchema.parse(value); }
      else if (name === "review") reviewSchema.parse(value);
      else if (name === "lastReviewCompletedAt") timestamp.parse(value);
      else if (name === "cleanupDismissals") cleanupDismissalsSchema.parse(value);
      else if (name === "weeklyDiagnosticSnapshots") diagnosticSnapshotsSchema.parse(value);
      else if (name.startsWith("focus_session.")) sessionSchema.parse(value);
      else throw new Error(`Unsupported imported state field: ${name}`);
    }
    if (state.focus && !snapshot.records.task.some(t => t.id === state.focus.taskId)) throw new Error("Invalid imported focus task reference.");
    if (state.review && (state.review.taskIds.some(id => !snapshot.records.task.some(t => t.id === id)) ||
      state.review.projectIds.some(id => !snapshot.records.project.some(p => p.id === id)))) throw new Error("Invalid imported review state.");
    return snapshot;
  }
  importSnapshot(input) {
    const snapshot = this.validateImport(input);
    return this.store.transaction(() => {
      const current = this.store.snapshot();
      if (Object.values(current.records).some(rows => rows.length) || Object.keys(current.state).length || this.store.revision() !== 0) throw new Error("Import requires an empty destination database.");
      for (const [kind, rows] of Object.entries(snapshot.records)) for (const record of rows) this.store.put(kind, record);
      for (const [key, value] of Object.entries(snapshot.state)) this.store.setState(key, value);
      // Imported events are evidence from the source, not events performed here.
      for (const sourceEvent of snapshot.history) this.store.event({ namespace: "mcp_v1", operation: "imported_history", sourceEvent });
      this.log("import", [], null, this.now()); this.store.bump();
      return { imported: Object.fromEntries(Object.entries(snapshot.records).map(([kind, rows]) => [kind, rows.length])) };
    });
  }
}
