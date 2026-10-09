const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const millis = value => value instanceof Date ? value.getTime() : new Date(value).getTime();

function findClosestSnapshot(sorted, target) {
  if (!sorted.length) return null;
  let closest = sorted[0];
  let closestDiff = Math.abs(millis(closest.capturedAt) - target.getTime());
  for (let i = 1; i < sorted.length; i++) {
    const diff = Math.abs(millis(sorted[i].capturedAt) - target.getTime());
    if (diff < closestDiff) {
      closest = sorted[i];
      closestDiff = diff;
    }
  }
  return closest;
}

export function computeWeeklyDiagnostics(events, snapshots, now) {
  const sevenDaysAgo = new Date(now.getTime() - SEVEN_DAYS_MS);
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);
  const countSince = (eventType, since) => events.filter(event =>
    event.eventType === eventType && millis(event.timestamp) >= since.getTime()).length;
  const completed7 = countSince("task_completed", sevenDaysAgo);
  const rescheduled7 = countSince("task_rescheduled", sevenDaysAgo);
  const completed30 = countSince("task_completed", thirtyDaysAgo);
  const rescheduled30 = countSince("task_rescheduled", thirtyDaysAgo);

  let backlogDelta = null;
  let backlogTrend = null;
  if (snapshots.length) {
    const sorted = [...snapshots].sort((a, b) => millis(a.capturedAt) - millis(b.capturedAt));
    const latest = sorted[sorted.length - 1];
    const week = findClosestSnapshot(sorted, sevenDaysAgo);
    if (week && latest) backlogDelta = latest.openTaskCount - week.openTaskCount;
    const month = findClosestSnapshot(sorted, thirtyDaysAgo);
    if (month && latest) {
      const delta = latest.openTaskCount - month.openTaskCount;
      backlogTrend = delta > 3 ? "up" : delta < -3 ? "down" : "stable";
    }
  }
  return {
    last7: { completed: completed7, rescheduled: rescheduled7, backlogDelta },
    baseline30: {
      avgCompletedPerWeek: Math.round(completed30 / (30 / 7)),
      avgRescheduledPerWeek: Math.round(rescheduled30 / (30 / 7)),
      backlogTrend,
    },
  };
}
