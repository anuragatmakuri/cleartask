import { snapshotSchema } from "./schemas.js";
import { validateRelationships } from "./domain.js";

const dateKeys = /(?:At|Date)$|^(time|snoozedUntil|nextVisibleAt|nextOccurrence)$/;
function convertDates(value, field = "") {
  if (value === null || value === undefined) return value;
  if (dateKeys.test(field)) {
    if (typeof value === "string") {
      if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid timestamp: ${field}`);
      return new Date(value).toISOString();
    }
    if (typeof value === "object") {
      const seconds = value.seconds ?? value._seconds;
      const nanos = value.nanoseconds ?? value._nanoseconds ?? 0;
      if (typeof seconds !== "number" || !Number.isInteger(seconds) || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9) throw new Error(`Invalid Firestore timestamp: ${field}`);
      return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
    }
    throw new Error(`Unsupported timestamp: ${field}`);
  }
  if (Array.isArray(value)) return value.map(item => convertDates(item));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convertDates(item, key)]));
  return value;
}

// Converts a prepared, single-owner JSON export only. Does not fetch Firebase,
// access credentials, modify source records, or import into a destination.
export function convertFirestoreExport(input, now = new Date()) {
  if (input?.format !== "cleartask-firestore-export" || typeof input.userId !== "string" || !input.userId) throw new Error("Expected a prepared single-owner cleartask-firestore-export.");
  const allowed = new Set(["format", "userId", "tasks", "projects", "spaces"]);
  if (Object.keys(input).some(k => !allowed.has(k))) throw new Error("Unsupported export fields; explicitly select tasks, projects, and spaces. Device review/focus state is not included.");
  const records = { task: [], project: [], space: [] };
  for (const [kind, plural] of [["task", "tasks"], ["project", "projects"], ["space", "spaces"]]) {
    if (!Array.isArray(input[plural])) throw new Error(`Missing ${plural} array.`);
    for (const raw of input[plural]) {
      if (raw.userId !== input.userId) throw new Error("Mixed-owner or missing-owner record; conversion refused.");
      const { userId, ...fields } = convertDates(raw);
      const base = { version: 1, deletedAt: null, lastActivityAt: fields.createdAt, ...fields };
      if (!base.createdAt) throw new Error("Each exported record must have createdAt.");
      if (kind === "task") records.task.push({
        important: false, completedAt: null, nextVisibleAt: null, reviewedAt: null,
        deferralCount: 0, reminders: [], projectId: null, spaceId: null, parentId: null, ...base,
      });
      else records[kind].push({ isArchived: Boolean(fields.archivedAt), ...(kind === "project" ? { spaceId: null } : {}), ...base });
    }
  }
  for (const task of records.task) {
    if (!task.parentId) continue;
    const parent = records.task.find(t => t.id === task.parentId);
    if (!parent) throw new Error("Export contains an orphan subtask.");
    // Legacy children may omit inherited fields. Populate only absent fields;
    // explicit conflicting values are rejected by relationship validation.
    const raw = input.tasks.find(t => t.id === task.id);
    if (!Object.hasOwn(raw, "spaceId")) task.spaceId = parent.spaceId;
    if (!Object.hasOwn(raw, "projectId")) task.projectId = parent.projectId;
  }
  const snapshot = snapshotSchema.parse({
    format: "cleartask-mcp", formatVersion: 1, exportedAt: now.toISOString(),
    records, state: {}, history: [],
  });
  validateRelationships(snapshot.records);
  return snapshot;
}
