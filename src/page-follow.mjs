export function uniqueScreenCandidate(pages) {
  const candidates = pages.filter((page) => page.candidate);
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function choosePageTarget(pages, selectedId, automatic) {
  if (automatic) {
    const candidate = uniqueScreenCandidate(pages);
    if (candidate) return candidate.id;
  }
  if (pages.some((page) => page.id === selectedId)) return selectedId;
  return pages[0]?.id || '';
}

export function nextInspectorRetry(completedAttempts, maximum = 3) {
  if (!Number.isInteger(completedAttempts) || completedAttempts < 0 || !Number.isInteger(maximum) || maximum < 1) return null;
  const attempt = completedAttempts + 1;
  if (attempt > maximum) return null;
  return { attempt, delay: Math.min(4000, 1000 * 2 ** (attempt - 1)) };
}
