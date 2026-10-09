const DAY = 24 * 60 * 60 * 1000;
export const CLEANUP_MODEL_VERSION = "cleanup_v2";

const date = value => value == null ? null : value instanceof Date ? value : new Date(value);
const time = value => date(value)?.getTime() ?? 0;
const completed = task => Boolean(task.completedAt);
const deleted = task => Boolean(task.deletedAt);
const visible = (task, now) => !task.nextVisibleAt || time(task.nextVisibleAt) <= now.getTime();
const activeTopLevel = (task, now) =>
  !completed(task) && !deleted(task) && visible(task, now) && !task.parentId;

const CONFIDENCE_BASE = {
  stale: 0.70,
  duplicate: 0.80,
  vague: 0.60,
  overloaded: 0.65,
  postponed: 0.75,
};

const REASON_CODE_MAP = {
  stale: "DECAY_PATTERN",
  duplicate: "HIGH_SIMILARITY",
  vague: "LOW_INFORMATION",
  overloaded: "PROJECT_DENSITY",
  postponed: "EXCESSIVE_DEFERRAL",
};

const VAGUE_PATTERNS = [
  /^do\s/i, /^fix\s/i, /^check\s/i, /^handle\s/i,
  /^stuff$/i, /^things$/i, /^todo$/i, /^tbd$/i,
  /^asap$/i, /^something$/i, /^misc$/i, /^other$/i, /^etc$/i,
  /^\?+$/, /^\.+$/,
];

function deterministicId(taskId, reasonCode) {
  let hash = 0;
  const input = `${taskId}:${reasonCode}:${CLEANUP_MODEL_VERSION}`;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return `cs_${Math.abs(hash).toString(36)}`;
}

function reasonCode(type) {
  return REASON_CODE_MAP[type] ?? "DECAY_PATTERN";
}

function confidence(type, isSafe) {
  return (CONFIDENCE_BASE[type] ?? 0.5) - (isSafe ? 0 : 0.2);
}

function vagueTitle(title) {
  const trimmed = title.trim().toLowerCase();
  if (trimmed.length <= 3) return true;
  if (trimmed.length < 15 && !trimmed.includes(" ")) return true;
  return VAGUE_PATTERNS.some(pattern => pattern.test(trimmed));
}

function taskAge(task, now) {
  return Math.floor((now.getTime() - time(task.createdAt)) / DAY);
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function jaccardSimilarity(a, b) {
  const wordsA = normalizeText(a).split(" ");
  const wordsB = normalizeText(b).split(" ");
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const intersection = [...setA].filter(word => setB.has(word)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

function behavioralSuffix(task) {
  const parts = [];
  if (task.staleness_score != null) parts.push(`Staleness score: ${task.staleness_score}/100`);
  if (task.intent_confidence != null && task.intent_confidence < 0.5) {
    parts.push(`Low clarity (${Math.round(task.intent_confidence * 100)}%)`);
  }
  if ((task.deferralCount ?? 0) >= 3) parts.push(`Deferred ${task.deferralCount} times`);
  return parts.length ? ` [${parts.join(" | ")}]` : "";
}

export function analyzeTasksForCleanup(tasks, projects, now = new Date()) {
  const suggestions = [];
  const activeTasks = tasks.filter(task => activeTopLevel(task, now));

  for (const task of activeTasks) {
    const age = taskAge(task, now);
    if (age >= 21) {
      const suffix = behavioralSuffix(task);
      suggestions.push({
        id: deterministicId(task.id, reasonCode("stale")),
        type: "stale",
        action: "hide_until_later",
        taskId: task.id,
        task,
        reason: `Not updated in ${age} days`,
        explanation: `This task has been sitting for ${age} days without progress. Consider hiding it until you're ready to work on it, or archiving if it's no longer relevant.${suffix}`,
        isSafe: true,
        confidenceScore: confidence("stale", true),
        reasonCode: reasonCode("stale"),
        modelVersion: CLEANUP_MODEL_VERSION,
      });
    }
  }

  const seenTitles = new Map();
  for (const task of activeTasks) {
    const normalized = normalizeText(task.title);
    for (const [existingNormalized, existingTask] of seenTitles) {
      const similarity = jaccardSimilarity(task.title, existingTask.title);
      if (similarity >= 0.7 || normalized === existingNormalized) {
        const suffix = behavioralSuffix(task);
        suggestions.push({
          id: deterministicId(task.id, reasonCode("duplicate")),
          type: "duplicate",
          action: "archive",
          taskId: task.id,
          task,
          reason: `Similar to "${existingTask.title}"`,
          explanation: `This task appears to be a duplicate of "${existingTask.title}". Consider merging them or archiving one.${suffix}`,
          isSafe: false,
          confidenceScore: confidence("duplicate", false),
          reasonCode: reasonCode("duplicate"),
          modelVersion: CLEANUP_MODEL_VERSION,
        });
        break;
      }
    }
    seenTitles.set(normalized, task);
  }

  const projectTaskCounts = new Map();
  for (const task of activeTasks) {
    if (task.projectId) projectTaskCounts.set(task.projectId, (projectTaskCounts.get(task.projectId) ?? 0) + 1);
  }
  for (const [projectId, count] of projectTaskCounts) {
    if (count <= 10) continue;
    const project = projects.find(item => item.id === projectId);
    const oldestNonImportant = activeTasks
      .filter(task => task.projectId === projectId && !task.important)
      .sort((a, b) => taskAge(b, now) - taskAge(a, now))[0];
    if (!oldestNonImportant) continue;
    const suffix = behavioralSuffix(oldestNonImportant);
    suggestions.push({
      id: deterministicId(oldestNonImportant.id, reasonCode("overloaded")),
      type: "overloaded",
      action: "hide_until_later",
      taskId: oldestNonImportant.id,
      task: oldestNonImportant,
      reason: `Project "${project?.name || "Unknown"}" has ${count} active tasks`,
      explanation: "The project has too many active tasks. Consider hiding some lower-priority items to reduce cognitive load." + suffix,
      isSafe: true,
      confidenceScore: confidence("overloaded", true),
      reasonCode: reasonCode("overloaded"),
      modelVersion: CLEANUP_MODEL_VERSION,
    });
  }

  for (const task of activeTasks) {
    if (!vagueTitle(task.title)) continue;
    const suffix = behavioralSuffix(task);
    suggestions.push({
      id: deterministicId(task.id, reasonCode("vague")),
      type: "vague",
      action: "rewrite_title",
      taskId: task.id,
      task,
      reason: "Title is not specific enough",
      explanation: `"${task.title}" doesn't clearly describe what needs to be done. A clearer title helps you take action faster.${suffix}`,
      isSafe: false,
      confidenceScore: confidence("vague", false),
      reasonCode: reasonCode("vague"),
      modelVersion: CLEANUP_MODEL_VERSION,
    });
  }

  return { suggestions, totalTasksAnalyzed: activeTasks.length, analysisDate: now, modelVersion: CLEANUP_MODEL_VERSION };
}

function daysSince(value, now) {
  return Math.floor((now.getTime() - time(value)) / DAY);
}

function levenshteinSimilarity(a, b) {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const matrix = Array.from({ length: s1.length + 1 }, () => Array(s2.length + 1).fill(0));
  for (let i = 0; i <= s1.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= s2.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return 1 - matrix[s1.length][s2.length] / Math.max(s1.length, s2.length);
}

function scoreDuplicates(tasks, now) {
  const results = [];
  const activeTasks = tasks.filter(task => activeTopLevel(task, now));
  for (let i = 0; i < activeTasks.length; i++) {
    const taskA = activeTasks[i];
    for (let j = i + 1; j < activeTasks.length; j++) {
      const taskB = activeTasks[j];
      const similarity = levenshteinSimilarity(taskA.title, taskB.title);
      if (similarity < 0.95) continue;
      const sameSpace = taskA.spaceId === taskB.spaceId;
      const sameProject = taskA.projectId === taskB.projectId;
      const daysBetween = Math.abs(time(taskA.createdAt) - time(taskB.createdAt)) / DAY;
      const createdWithinWindow = daysBetween <= 3;
      let score = Math.round(similarity * 100);
      if (sameSpace && sameProject) score = Math.min(100, score + 10);
      if (createdWithinWindow) score = Math.min(100, score + 5);
      if (sameSpace && sameProject && createdWithinWindow) {
        results.push({
          taskId: taskB.id,
          reason: "duplicate",
          relatedTaskId: taskA.id,
          score,
          explanation: `Nearly identical to "${taskA.title}" (${Math.round(similarity * 100)}% match), same location, created ${daysBetween.toFixed(0)} days apart`,
          task: taskB,
          relatedTask: taskA,
        });
      }
    }
  }
  return results;
}

function scoreStaleTasks(tasks, now) {
  return tasks.filter(task => activeTopLevel(task, now)).flatMap(task => {
    const days = daysSince(task.lastActivityAt || task.createdAt, now);
    if (days < 30 || task.dueDate || task.reminders?.length) return [];
    return [{
      taskId: task.id,
      reason: "stale",
      score: Math.min(100, 50 + Math.floor((days - 30) / 7) * 10),
      explanation: `Untouched for ${days} days with no due date or reminders`,
      task,
    }];
  });
}

function scoreAbandonedSubtasks(tasks, now) {
  const results = [];
  for (const subtask of tasks.filter(task => task.parentId && !completed(task))) {
    const parent = tasks.find(task => task.id === subtask.parentId);
    if (!parent || !completed(parent)) continue;
    const days = daysSince(subtask.lastActivityAt || subtask.createdAt, now);
    if (days <= 14) continue;
    results.push({
      taskId: subtask.id,
      reason: "abandonedSubtask",
      relatedTaskId: parent.id,
      score: Math.min(100, 60 + Math.floor((days - 14) / 7) * 10),
      explanation: `Parent task "${parent.title}" is complete but this subtask remains open (${days} days inactive)`,
      task: subtask,
      relatedTask: parent,
    });
  }
  return results;
}

function scoreConflictingTitles(tasks, now) {
  const results = [];
  const activeTasks = tasks.filter(task => activeTopLevel(task, now));
  const titleGroups = new Map();
  for (const task of activeTasks) {
    const title = task.title.toLowerCase().trim();
    const group = titleGroups.get(title) ?? [];
    group.push(task);
    titleGroups.set(title, group);
  }
  for (const [title, tasksWithTitle] of titleGroups) {
    if (tasksWithTitle.length <= 1) continue;
    const locations = new Set(tasksWithTitle.map(task => `${task.spaceId || "none"}-${task.projectId || "none"}`));
    if (locations.size <= 1) continue;
    for (let i = 1; i < tasksWithTitle.length; i++) {
      const task = tasksWithTitle[i];
      const relatedTask = tasksWithTitle[0];
      results.push({
        taskId: task.id,
        reason: "conflicting",
        relatedTaskId: relatedTask.id,
        score: 75,
        explanation: `Same title "${task.title}" exists in different locations - may cause confusion`,
        task,
        relatedTask,
      });
    }
  }
  return results;
}

export function computeDetailedCleanupScores(tasks, now = new Date()) {
  const allResults = [
    ...scoreDuplicates(tasks, now),
    ...scoreStaleTasks(tasks, now),
    ...scoreAbandonedSubtasks(tasks, now),
    ...scoreConflictingTitles(tasks, now),
  ].sort((a, b) => b.score - a.score);
  const seenTaskIds = new Set();
  return allResults.filter(result => {
    if (seenTaskIds.has(result.taskId)) return false;
    seenTaskIds.add(result.taskId);
    return true;
  });
}
