export const MAX_PHOTO_SELECTION = 100;

export function collectCloudSelection<T, A extends { id: string; library: string }>(items: T[], match: (item: T) => A | null) {
  const assets = new Map<string, A>();
  const matched: Array<{ item: T; asset: A }> = [];
  const skipped: T[] = [];
  for (const item of items) {
    const asset = match(item);
    if (!asset) { skipped.push(item); continue; }
    matched.push({ item, asset });
    assets.set(`${asset.library}:${asset.id}`, asset);
  }
  return { assets: [...assets.values()], matched, skipped };
}
