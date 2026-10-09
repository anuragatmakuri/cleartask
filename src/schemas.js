import { z } from "zod";

export const id = z.string().min(1).max(160).regex(/^[\w.-]+$/);
export const timestamp = z.iso.datetime({ offset: true });
export const key = z.string().min(8).max(160);
export const version = z.number().int().positive();
export const entity = z.enum(["task", "project", "space"]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const name = z.string().trim().min(1).max(200);
export const reminder = z.object({
  id, time: timestamp, type: z.enum(["custom", "smart"]).default("custom"),
  handled: z.boolean().default(false), suppressed: z.boolean().default(false),
  status: z.enum(["inactive", "active", "snoozed", "dismissed", "resolved"]).default("inactive"),
  snoozedUntil: timestamp.nullable().optional(),
  repeatInterval: z.enum(["daily", "weekdays", "weekly", "biweekly", "monthly"]).nullable().optional(),
  ignoredCount: z.number().int().nonnegative().default(0),
  snoozeCountRolling30d: z.number().int().nonnegative().default(0),
  dismissCountRolling30d: z.number().int().nonnegative().default(0),
  fireCountRolling30d: z.number().int().nonnegative().default(0),
  lastFiredAt: timestamp.nullable().optional(),
  lastSnoozedAt: timestamp.nullable().optional(),
  lastDismissedAt: timestamp.nullable().optional(),
  spaceId: id.nullable().optional(),
}).strict();
export const taskData = z.object({
  title: name.optional(), description: z.string().max(5000).nullable().optional(),
  dueDate: timestamp.nullable().optional(), important: z.boolean().optional(),
  projectId: id.nullable().optional(), spaceId: id.nullable().optional(),
  parentId: id.nullable().optional(), estimatedMinutes: z.number().int().min(1).max(10080).nullable().optional(),
  reminders: z.array(reminder).max(20).optional(),
  lastProgressAt: timestamp.nullable().optional(),
  dateCommitmentSource: z.enum(["user", "ai"]).nullable().optional(),
  reminderResistance: z.boolean().optional(),
  reminderResistanceComputedAt: timestamp.nullable().optional(),
  intent_confidence: z.number().min(0).max(1).nullable().optional(),
  commitment_strength: z.enum(["firm", "tentative", "aspirational"]).nullable().optional(),
  time_certainty_score: z.number().min(0).max(1).nullable().optional(),
  cognitive_load_band: z.enum(["low", "medium", "high"]).nullable().optional(),
  staleness_score: z.number().min(0).max(100).nullable().optional(),
  staleness_computed_at: timestamp.nullable().optional(),
  resolution_type: z.enum(["completed", "abandoned", "decayed", "cleanup_removed"]).nullable().optional(),
  cleanup_flag: z.boolean().optional(),
  energy_alignment_score: z.number().min(0).max(1).nullable().optional(),
  behavior_model_version: z.string().max(80).nullable().optional(),
}).strict();
export const projectData = z.object({
  name: name.optional(), color: color.optional(), spaceId: id.nullable().optional(),
}).strict();
export const spaceData = z.object({
  name: name.optional(), color: color.optional(), icon: z.string().min(1).max(40).optional(),
  pinnedColumn: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().optional(),
}).strict();
export const dataSchemas = { task: taskData, project: projectData, space: spaceData };
export const operation = z.object({
  entity,
  action: z.enum(["create", "update", "complete", "reopen", "defer", "archive", "unarchive", "delete", "restore"]),
  id: id.optional(), expectedVersion: version.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  until: timestamp.optional(),
}).strict().superRefine((op, ctx) => {
  const fail = (message) => ctx.addIssue({ code: "custom", message });
  if (op.action === "create") {
    if (op.id || op.expectedVersion) fail("Creates cannot supply an id or version.");
    if (!op.data?.[op.entity === "task" ? "title" : "name"]) fail("A title/name is required.");
  } else if (!op.id || !op.expectedVersion) fail("Existing records require id and expectedVersion from a read.");
  if (["complete", "reopen", "defer"].includes(op.action) && op.entity !== "task") fail("This action is task-only.");
  if (op.action === "unarchive" && op.entity === "task") fail("Use reopen for completed/archived tasks.");
  if (op.action === "defer" && !op.until) fail("Defer requires an offset ISO timestamp.");
  if (op.until && op.action !== "defer") fail("until is only valid for defer.");
  if (op.data && !["create", "update"].includes(op.action)) fail("data is only valid for create/update.");
  if (op.action === "update" && (!op.data || !Object.keys(op.data).length)) fail("Provide at least one edit.");
  const parsed = dataSchemas[op.entity].safeParse(op.data ?? {});
  if (!parsed.success) fail(parsed.error.message);
});
export const mutation = z.object({ operation, idempotencyKey: key }).strict();
export const previewInput = z.object({
  operations: z.array(operation).min(1).max(50),
  idempotencyKey: key,
}).strict();
export const listInput = z.object({
  entity, query: z.string().max(200).optional(),
  status: z.enum(["active", "completed", "deleted", "archived", "all"]).default("active"),
  projectId: id.optional(), spaceId: id.optional(), parentId: id.optional(),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).max(100000).default(0),
}).strict();

export const cleanupQueryInput = z.object({
  suggestionOffset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(20).default(5),
  scoreOffset: z.number().int().min(0).max(100000).default(0),
  scoreLimit: z.number().int().min(1).max(100).default(30),
}).strict();

export const cleanupActionInput = z.object({
  itemType: z.enum(["suggestion", "score"]),
  taskId: id,
  suggestionId: id.optional(),
  reason: z.enum(["duplicate", "stale", "abandonedSubtask", "conflicting"]).optional(),
  relatedTaskId: id.optional(),
  expectedVersion: version,
  action: z.enum(["skip", "defer", "complete", "rewrite_title"]),
  until: timestamp.optional(),
  newTitle: name.optional(),
  idempotencyKey: key,
}).strict().superRefine((args, ctx) => {
  const fail = message => ctx.addIssue({ code: "custom", message });
  if (args.itemType === "suggestion" && (!args.suggestionId || args.reason || args.relatedTaskId)) {
    fail("Suggestions require suggestionId and cannot include score fields.");
  }
  if (args.itemType === "score" && (args.suggestionId || !args.reason)) {
    fail("Scores require reason and cannot include suggestionId.");
  }
  if (args.itemType === "score" && !["skip", "complete"].includes(args.action)) {
    fail("Detailed cleanup scores support skip or complete.");
  }
  if (args.action === "defer" && !args.until) fail("Defer requires until.");
  if (args.action !== "defer" && args.until) fail("until is only valid for defer.");
  if (args.action === "rewrite_title" && !args.newTitle) fail("rewrite_title requires newTitle.");
  if (args.action !== "rewrite_title" && args.newTitle) fail("newTitle is only valid for rewrite_title.");
});

export const projectReviewInput = z.object({
  sessionId: id,
  projectId: id,
  expectedVersion: version,
  action: z.enum(["project_add_task", "project_review", "project_archive"]),
  confirmed: z.boolean().default(false),
  idempotencyKey: key,
}).strict().superRefine((args, ctx) => {
  if (args.action === "project_archive" && !args.confirmed) {
    ctx.addIssue({ code: "custom", message: "Project archive requires explicit owner confirmation." });
  }
});

const storedBase = { id, version, createdAt: timestamp, lastActivityAt: timestamp, deletedAt: timestamp.nullable() };
export const storedSchemas = {
  task: taskData.extend({
    ...storedBase, title: name, important: z.boolean(),
    completedAt: timestamp.nullable(), nextVisibleAt: timestamp.nullable(),
    reviewedAt: timestamp.nullable(), deferralCount: z.number().int().nonnegative(),
    deletionGroup: id.nullable().optional(),
  }).passthrough(),
  project: projectData.extend({ ...storedBase, name, isArchived: z.boolean(), deletionGroup: id.nullable().optional() }).passthrough(),
  space: spaceData.extend({ ...storedBase, name, isArchived: z.boolean(), deletionGroup: id.nullable().optional() }).passthrough(),
};
export const snapshotSchema = z.object({
  format: z.literal("cleartask-mcp"), formatVersion: z.literal(1), exportedAt: timestamp,
  records: z.object({
    task: z.array(storedSchemas.task).max(10000),
    project: z.array(storedSchemas.project).max(10000),
    space: z.array(storedSchemas.space).max(10000),
  }).strict(),
  state: z.record(z.string(), z.unknown()),
  history: z.array(z.record(z.string(), z.unknown())).max(100000),
}).strict();
