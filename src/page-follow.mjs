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
