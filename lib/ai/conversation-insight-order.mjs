const PRIORITY_BY_NAME = new Map([
  ["summary", 0],
  ["sentiment", 1],
]);

function insightPriority(insight) {
  const name = String(insight?.title || "").trim().toLowerCase();
  return PRIORITY_BY_NAME.get(name);
}

export function orderConversationInsights(insights) {
  if (!Array.isArray(insights)) return [];

  const prioritized = [];
  const remaining = [];
  for (const [index, insight] of insights.entries()) {
    const priority = insightPriority(insight);
    if (priority === undefined) {
      remaining.push(insight);
    } else {
      prioritized.push({ insight, index, priority });
    }
  }

  if (prioritized.length === 0) return insights;

  prioritized.sort(
    (left, right) => left.priority - right.priority || left.index - right.index
  );
  return [...prioritized.map(({ insight }) => insight), ...remaining];
}
