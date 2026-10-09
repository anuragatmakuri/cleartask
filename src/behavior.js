// Platform-independent focus_v3 and weekly-review V0 behavior.
// Parity is tested against the original app sources. No inference or I/O.
export const FOCUS_MODEL_VERSION = "focus_v3";
const DAY = 86400000;
const date = value => value ? new Date(value) : null;
const time = value => date(value)?.getTime() ?? 0;
const today = now => new Date(now.getFullYear(), now.getMonth(), now.getDate());
const open = task => !task.completedAt && !task.deletedAt;
const visible = (task, now) => !task.nextVisibleAt || time(task.nextVisibleAt) <= now.getTime();

export function getReviewCycleStart(now) {
  const result = new Date(now);
  result.setDate(result.getDate() - (result.getDay() + 6) % 7);
  result.setHours(6, 0, 0, 0);
  if (result > now) result.setDate(result.getDate() - 7);
  return result;
}

function tie(a, b) {
  if (a.dueDate && b.dueDate && time(a.dueDate) !== time(b.dueDate)) return time(a.dueDate) - time(b.dueDate);
  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;
  return time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id);
}

export function focusSelection(tasks, now, { spaceId, limit = 5 } = {}) {
  // The Home/Focus caller excludes hidden tasks and subtasks before scoring.
  const filtered = tasks.filter(t => open(t) && visible(t, now) && !t.parentId && (!spaceId || t.spaceId === spaceId));
  const start = today(now).getTime();
  const active = task => task.reminders?.some(r => !r.handled && !r.suppressed && time(r.snoozedUntil || r.time) <= now.getTime());
  const priority = t => t.dueDate && time(t.dueDate) < start ? 0 : t.dueDate && today(date(t.dueDate)).getTime() === start ? 1 : 2;
  const score = task => {
    const breakdown = {};
    if (priority(task) === 0) breakdown.overdue = 100;
    else if (priority(task) === 1) breakdown.dueToday = 80;
    if (task.important) { breakdown.important = 50; breakdown.importantBoost = 0.15; }
    if (!spaceId) {
      if (active(task)) breakdown.activeReminder = 40;
    }
    if (task.deferralCount >= 2) breakdown.deferralBias = 15;
    if (!task.dueDate && Math.floor((now.getTime() - time(task.createdAt)) / DAY) > 14) breakdown.stalenessBias = 10;
    return { task, score: Object.values(breakdown).reduce((a, b) => a + b, 0), scoreBreakdown: breakdown };
  };
  let ranked;
  if (spaceId) {
    ranked = filtered.filter(t => priority(t) < 2 || t.important)
      .sort((a, b) => priority(a) - priority(b) || tie(a, b)).slice(0, limit).map(score);
  } else {
    ranked = filtered.map(score).filter(t => t.score > 0)
      .sort((a, b) => b.score - a.score || tie(a.task, b.task)).slice(0, limit);
    if (ranked.length < 5) {
      const used = new Set(ranked.map(t => t.task.id));
      const fallback = filtered.filter(t => !used.has(t.id) && !t.dueDate && !t.important && !active(t))
        .sort((a, b) => time(b.lastActivityAt || b.createdAt) - time(a.lastActivityAt || a.createdAt) || a.id.localeCompare(b.id))
        .slice(0, Math.min(2, 5 - ranked.length));
      ranked.push(...fallback.map(task => ({ task, score: 0, scoreBreakdown: { fallback: 0 } })));
    }
  }
  // Original scoring can add fallbacks beyond a requested low cap; tool output
  // remains bounded, with the same ordering, by slicing only at this boundary.
  return { version: FOCUS_MODEL_VERSION, items: ranked.slice(0, limit) };
}

export function reviewSelection(tasks, projects, now) {
  const start = today(now).getTime();
  const cycle = getReviewCycleStart(now).getTime();
  const eligible = tasks.filter(t => open(t) && visible(t, now) && !t.parentId);
  const reviewed = t => t.reviewedAt && time(t.reviewedAt) >= cycle;
  const byDue = (a, b) => time(a.dueDate) - time(b.dueDate);
  const overdue = eligible.filter(t => t.dueDate && time(t.dueDate) < start && (!reviewed(t) || time(t.dueDate) >= time(t.reviewedAt))).sort(byDue);
  const upcoming = eligible.filter(t => t.dueDate && time(t.dueDate) >= start && time(t.dueDate) <= start + 7 * DAY && !reviewed(t)).sort(byDue).slice(0, 12);
  const noMovementProjects = [];
  for (const project of projects.filter(p => !p.isArchived && !p.deletedAt)) {
    const all = tasks.filter(t => t.projectId === project.id && !t.deletedAt);
    const active = all.filter(open);
    if (!active.length) continue;
    if (all.some(t => t.completedAt && time(t.completedAt) >= now.getTime() - 7 * DAY)) continue;
    if (active.some(t => time(t.lastActivityAt || t.updatedAt || t.createdAt) >= now.getTime() - 7 * DAY)) continue;
    if (active.some(t => t.dueDate && time(t.dueDate) >= now.getTime() && time(t.dueDate) <= now.getTime() + 7 * DAY)) continue;
    const latest = Math.max(...active.map(t => time(t.lastActivityAt || t.updatedAt || t.createdAt)));
    const lastActivityAgeDays = latest ? Math.floor((now.getTime() - latest) / DAY) : null;
    noMovementProjects.push({ project, openTaskCount: active.length, lastActivityAgeDays, reason: latest ? `No activity in ${lastActivityAgeDays} days` : "No activity recorded" });
  }
  noMovementProjects.sort((a, b) => (b.lastActivityAgeDays ?? Infinity) - (a.lastActivityAgeDays ?? Infinity));
  const backlogCandidates = eligible.filter(t => {
    const isBacklog = !t.dueDate || Math.round((today(date(t.dueDate)).getTime() - start) / DAY) > 7;
    return isBacklog && !reviewed(t) && Math.floor((now.getTime() - time(t.lastActivityAt || t.createdAt)) / DAY) >= 14;
  }).sort((a, b) => time(a.dueDate || a.lastActivityAt || a.createdAt) - time(b.dueDate || b.lastActivityAt || b.createdAt)).slice(0, 10);
  return { overdue, upcoming, noMovementProjects: noMovementProjects.slice(0, 5), backlogCandidates, cycleStart: new Date(cycle).toISOString() };
}
