export function viewerAfterRemoval(currentId: string | null, displayedIds: string[], remainingIds: ReadonlySet<string>): string | null {
  if (!currentId || remainingIds.has(currentId)) return currentId;
  const index = displayedIds.indexOf(currentId);
  for (let next = index + 1; next < displayedIds.length; next++) {
    if (remainingIds.has(displayedIds[next])) return displayedIds[next];
  }
  for (let previous = index - 1; previous >= 0; previous--) {
    if (remainingIds.has(displayedIds[previous])) return displayedIds[previous];
  }
  return null;
}
