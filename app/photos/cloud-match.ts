type LocalPhoto = { name: string; path: string; size: number; sourceName: string };
type MatchedAsset = { name: string; mediaType: "photo" | "video"; mainBytes: number; localFiles: string[] };

function normalize(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

export function findPhotoCloudAsset<T extends MatchedAsset>(item: LocalPhoto, plan: { status: string; assets: T[] } | null | undefined, backupDirectory?: string | null): T | null {
  if (plan?.status !== "confirmed") return null;
  const photoPath = normalize(item.path);
  const sourceName = normalize(item.sourceName);
  const candidates = plan.assets.filter(asset => asset.mediaType === "photo"
    && asset.name.toLowerCase() === item.name.toLowerCase()
    && asset.mainBytes === item.size
    && asset.localFiles.some(path => {
      const verifiedPath = normalize(path);
      // The browser path is relative to the selected source, which may be a
      // year/month subfolder rather than the full iCloud backup directory.
      const absolutePath = backupDirectory ? normalize(backupDirectory) + "/" + verifiedPath : verifiedPath;
      return verifiedPath === photoPath || (sourceName && (verifiedPath === sourceName + "/" + photoPath || absolutePath.endsWith("/" + sourceName + "/" + photoPath)));
    }));
  return candidates.length === 1 ? candidates[0] : null;
}
