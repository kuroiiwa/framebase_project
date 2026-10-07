import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const usernamePattern = /^[a-zA-Z0-9_]{3,32}$/;
const manifestExtensions = new Set(["jpg", "jpeg", "heic", "heif", "png", "gif", "tif", "tiff", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "mov", "mp4", "m4v", "avi", "mkv", "mpeg", "mpg", "webm"]);

function emptyConfig() {
  return {
    version: 2,
    selectedDirectory: null,
    backupDirectory: null,
    provider: "icloudpd",
    connectionStatus: "not_connected",
    appleAccount: null,
    icloudDomain: "cn",
    lastConnectionCheckAt: null,
    lastConnectionMessage: null,
    lastScanAt: null,
    lastBackupAt: null,
    updatedAt: null,
  };
}

function validateUsername(username) {
  if (!usernamePattern.test(username)) throw Object.assign(new Error("FrameBase 用户名无效。"), { status: 400 });
}

export function createIcloudManager({ projectRoot }) {
  const configRoot = join(projectRoot, ".framebase-icloud");
  let writes = Promise.resolve();

  function userDirectory(username) {
    validateUsername(username);
    return join(configRoot, username);
  }

  function configPath(username) {
    return join(userDirectory(username), "config.json");
  }

  function manifestPath(username) {
    return join(userDirectory(username), "manifest.json");
  }

  function backupResultPath(username) {
    return join(userDirectory(username), "last-backup.json");
  }

  function fullBackupPath(username) {
    return join(userDirectory(username), "full-backup.json");
  }

  function fullManifestPath(username) {
    return join(userDirectory(username), "full-manifest.json");
  }

  function releasePlanPath(username) {
    return join(userDirectory(username), "release-plan.json");
  }

  function timelinePath(username) {
    return join(userDirectory(username), "timeline.json");
  }

  function backupHistoryPath(username) {
    return join(userDirectory(username), "backup-history.json");
  }

  function releaseHistoryPath(username) {
    return join(userDirectory(username), "release-history.json");
  }

  function sha256File(path) {
    return new Promise((resolvePromise, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(path);
      stream.on("error", reject);
      stream.on("data", chunk => hash.update(chunk));
      stream.on("end", () => resolvePromise(hash.digest("hex")));
    });
  }

  async function atomicJson(username, destination, value) {
    const directory = userDirectory(username);
    const temporary = `${destination}.tmp`;
    const task = writes.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, destination);
    });
    writes = task.catch(() => undefined);
    await task;
  }

  function cleanFullFiles(files) {
    return Array.isArray(files) ? files.map(item => ({
      name: String(item?.name || ""),
      relativePath: String(item?.relativePath || item?.name || ""),
      extension: String(item?.extension || "").toLowerCase(),
      mediaType: item?.mediaType === "video" ? "video" : "photo",
      size: Math.max(0, Number(item?.size) || 0),
      modifiedMs: Math.max(0, Number(item?.modifiedMs) || 0),
      sha256: /^[a-f0-9]{64}$/.test(String(item?.sha256 || "")) ? item.sha256 : null,
      library: typeof item?.library === "string" ? item.library : null,
      verifiedAt: typeof item?.verifiedAt === "string" ? item.verifiedAt : null,
    })).filter(item => item.name && item.relativePath && item.size > 0 && item.sha256) : [];
  }

  async function readFullBackup(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(fullBackupPath(username), "utf8"));
      const allowed = new Set(["idle", "planning", "downloading", "verifying", "paused", "cancelled", "completed", "failed"]);
      return {
        status: allowed.has(parsed.status) ? parsed.status : "idle",
        message: typeof parsed.message === "string" ? parsed.message : "尚未开始完整备份。",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
        completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null,
        phase: typeof parsed.phase === "string" ? parsed.phase : "idle",
        currentLibrary: typeof parsed.currentLibrary === "string" ? parsed.currentLibrary : null,
        currentRange: typeof parsed.currentRange === "string" ? parsed.currentRange : null,
        rangeIndex: Math.max(0, Number(parsed.rangeIndex) || 0),
        rangeCount: Math.max(0, Number(parsed.rangeCount) || 0),
        completedRanges: Array.isArray(parsed.completedRanges) ? parsed.completedRanges.filter(item => typeof item === "string").slice(0, 60) : [],
        planned: Math.max(0, Number(parsed.planned) || 0),
        downloaded: Math.max(0, Number(parsed.downloaded) || 0),
        plannedPhotoCount: Math.max(0, Number(parsed.plannedPhotoCount) || 0),
        plannedVideoCount: Math.max(0, Number(parsed.plannedVideoCount) || 0),
        syncedPhotoCount: Math.max(0, Number(parsed.syncedPhotoCount) || 0),
        syncedVideoCount: Math.max(0, Number(parsed.syncedVideoCount) || 0),
        downloadedBytes: Math.max(0, Number(parsed.downloadedBytes) || 0),
        transferRateBps: Math.max(0, Number(parsed.transferRateBps) || 0),
        verified: Math.max(0, Number(parsed.verified) || 0),
        skipped: Math.max(0, Number(parsed.skipped) || 0),
        failed: Math.max(0, Number(parsed.failed) || 0),
        photoCount: Math.max(0, Number(parsed.photoCount) || 0),
        videoCount: Math.max(0, Number(parsed.videoCount) || 0),
        verifiedBytes: Math.max(0, Number(parsed.verifiedBytes) || 0),
        manifestFileCount: Math.max(0, Number(parsed.manifestFileCount) || 0),
        ranges: Array.isArray(parsed.ranges) ? parsed.ranges.filter(item => item && typeof item.key === "string" && typeof item.start === "string" && typeof item.end === "string").slice(0, 60) : [],
      };
    } catch (error) {
      if (error.code === "ENOENT") return { status: "idle", message: "尚未开始完整备份。", startedAt: null, updatedAt: null, completedAt: null, phase: "idle", currentLibrary: null, currentRange: null, rangeIndex: 0, rangeCount: 0, completedRanges: [], planned: 0, downloaded: 0, plannedPhotoCount: 0, plannedVideoCount: 0, syncedPhotoCount: 0, syncedVideoCount: 0, downloadedBytes: 0, transferRateBps: 0, verified: 0, skipped: 0, failed: 0, photoCount: 0, videoCount: 0, verifiedBytes: 0, manifestFileCount: 0, ranges: [] };
      throw error;
    }
  }

  async function readFullManifest(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(fullManifestPath(username), "utf8"));
      return { updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null, files: cleanFullFiles(parsed.files) };
    } catch (error) {
      if (error.code === "ENOENT") return { updatedAt: null, files: [] };
      throw error;
    }
  }

  async function readBackupCoverage(username) {
    const manifest = await readFullManifest(username);
    const years = new Map(); const quarters = new Map(); const months = new Map();
    const increment = (map, key, item) => {
      const bucket = map.get(key) || { key, verifiedCount: 0, verifiedBytes: 0, photoCount: 0, videoCount: 0 };
      bucket.verifiedCount += 1;
      bucket.verifiedBytes += item.size;
      if (item.mediaType === "video") bucket.videoCount += 1; else bucket.photoCount += 1;
      map.set(key, bucket);
    };
    for (const item of manifest.files) {
      const parts = item.relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
      const dateIndex = parts.findIndex((part, index) => /^\d{4}$/.test(part) && /^(0[1-9]|1[0-2])$/.test(parts[index + 1] || ""));
      if (dateIndex < 0) continue;
      const year = Number(parts[dateIndex]);
      const month = Number(parts[dateIndex + 1]);
      if (year < 1900 || year > 2200) continue;
      increment(years, String(year), item);
      increment(quarters, `${year}-Q${Math.floor((month - 1) / 3) + 1}`, item);
      increment(months, `${year}-${String(month).padStart(2, "0")}`, item);
    }
    const newestFirst = map => [...map.values()].sort((left, right) => right.key.localeCompare(left.key));
    return { updatedAt: manifest.updatedAt, fileCount: manifest.files.length, years: newestFirst(years), quarters: newestFirst(quarters), months: newestFirst(months) };
  }

  async function writeFullBackup(username, update) {
    const current = await readFullBackup(username);
    const next = { ...current, ...update, updatedAt: new Date().toISOString() };
    await atomicJson(username, fullBackupPath(username), { version: 1, ...next });
    return next;
  }

  async function writeFullManifest(username, files) {
    const previous = await readFullManifest(username);
    const byPath = new Map(previous.files.map(item => [item.relativePath, item]));
    for (const item of cleanFullFiles(files)) byPath.set(item.relativePath, item);
    const updatedAt = new Date().toISOString();
    const merged = [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    await atomicJson(username, fullManifestPath(username), { version: 1, updatedAt, fileCount: merged.length, files: merged });
    return { updatedAt, files: merged };
  }

  async function removeRecycledFromManifest(username, recycleResults) {
    const recycledPaths = new Set((Array.isArray(recycleResults) ? recycleResults : []).filter(item => item?.status === "recycled" && typeof item.relativePath === "string").map(item => item.relativePath));
    if (!recycledPaths.size) return readFullManifest(username);
    const current = await readFullManifest(username);
    const files = current.files.filter(file => !recycledPaths.has(file.relativePath));
    const updatedAt = new Date().toISOString();
    await atomicJson(username, fullManifestPath(username), { version: 1, updatedAt, fileCount: files.length, files });
    await writeFullBackup(username, { manifestFileCount: files.length });
    return { updatedAt, files };
  }

  function cleanTimelineBuckets(value) {
    return Array.isArray(value) ? value.map(item => ({
      key: String(item?.key || ""), itemCount: Math.max(0, Number(item?.itemCount) || 0),
      photoCount: Math.max(0, Number(item?.photoCount) || 0), videoCount: Math.max(0, Number(item?.videoCount) || 0),
      livePhotoCount: Math.max(0, Number(item?.livePhotoCount) || 0), rawCount: Math.max(0, Number(item?.rawCount) || 0),
      originalBytes: Math.max(0, Number(item?.originalBytes) || 0),
    })).filter(item => item.key).slice(0, 500) : [];
  }

  function cleanTimelineAssets(value) {
    return Array.isArray(value) ? value.map(item => ({
      id: String(item?.id || ""), library: String(item?.library || "default"), name: String(item?.name || ""),
      created: String(item?.created || ""), mediaType: item?.mediaType === "video" ? "video" : "photo",
      extension: String(item?.extension || "").toLowerCase(), originalBytes: Math.max(0, Number(item?.originalBytes) || 0),
      mainBytes: Math.max(0, Number(item?.mainBytes) || 0), livePhotoBytes: Math.max(0, Number(item?.livePhotoBytes) || 0),
      livePhoto: Boolean(item?.livePhoto), raw: Boolean(item?.raw),
    })).filter(item => item.id && item.name && !Number.isNaN(new Date(item.created).getTime()) && item.originalBytes > 0).slice(0, 50_000) : [];
  }

  function cleanReleaseAssets(value) {
    const sources = new Map((Array.isArray(value) ? value : []).map(item => [`${String(item?.library || "default")}:${String(item?.id || "")}`, item]));
    return cleanTimelineAssets(value).map(asset => {
      const source = sources.get(`${asset.library}:${asset.id}`);
      const localFiles = Array.isArray(source?.localFiles) ? source.localFiles.filter(path => typeof path === "string" && path && path.length <= 4096).slice(0, 8) : [];
      return { ...asset, localFiles };
    });
  }

  async function readTimeline(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(timelinePath(username), "utf8"));
      const assets = cleanTimelineAssets(parsed.assets);
      return {
        scannedAt: typeof parsed.scannedAt === "string" ? parsed.scannedAt : null,
        staleAt: typeof parsed.staleAt === "string" ? parsed.staleAt : null,
        staleReason: typeof parsed.staleReason === "string" ? parsed.staleReason : null,
        total: cleanTimelineBuckets([parsed.total])[0] || null,
        years: cleanTimelineBuckets(parsed.years), quarters: cleanTimelineBuckets(parsed.quarters), months: cleanTimelineBuckets(parsed.months),
        assetCount: assets.length, assets,
      };
    } catch (error) {
      if (error.code === "ENOENT") return { scannedAt: null, staleAt: null, staleReason: null, assetCount: 0, total: null, years: [], quarters: [], months: [], assets: [] };
      throw error;
    }
  }

  async function recordTimeline(username, result) {
    const timeline = {
      version: 2, scannedAt: typeof result.scannedAt === "string" ? result.scannedAt : new Date().toISOString(), staleAt: null, staleReason: null,
      total: cleanTimelineBuckets([result.total])[0] || null,
      years: cleanTimelineBuckets(result.years), quarters: cleanTimelineBuckets(result.quarters), months: cleanTimelineBuckets(result.months),
      assets: cleanTimelineAssets(result.assets),
    };
    timeline.assetCount = timeline.assets.length;
    await atomicJson(username, timelinePath(username), timeline);
    return timeline;
  }

  function cleanBackupRanges(value) {
    return Array.isArray(value) ? value.map(item => ({
      key: String(item?.key || ""), label: String(item?.label || ""),
      start: String(item?.start || ""), end: String(item?.end || ""),
      completedAt: typeof item?.completedAt === "string" ? item.completedAt : null,
    })).filter(item => item.key && item.label && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(item.start) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(item.end) && item.start <= item.end).slice(0, 500) : [];
  }

  async function readBackupHistory(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(backupHistoryPath(username), "utf8"));
      return { updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null, completedRanges: cleanBackupRanges(parsed.completedRanges) };
    } catch (error) {
      if (error.code === "ENOENT") return { updatedAt: null, completedRanges: [] };
      throw error;
    }
  }

  async function recordCompletedRanges(username, ranges) {
    const incoming = cleanBackupRanges(ranges);
    const current = await readBackupHistory(username);
    if (!incoming.length) return current;
    const byPeriod = new Map(current.completedRanges.map(item => [`${item.start}|${item.end}`, item]));
    const completedAt = new Date().toISOString();
    for (const item of incoming) byPeriod.set(`${item.start}|${item.end}`, { ...item, completedAt: item.completedAt || completedAt });
    const completedRanges = [...byPeriod.values()].sort((left, right) => left.start.localeCompare(right.start));
    if (completedRanges.length === current.completedRanges.length && incoming.every(item => current.completedRanges.some(saved => saved.start === item.start && saved.end === item.end))) return current;
    const history = { version: 1, updatedAt: completedAt, completedRanges };
    await atomicJson(username, backupHistoryPath(username), history);
    return { updatedAt: history.updatedAt, completedRanges: history.completedRanges };
  }

  async function readReleasePlan(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(releasePlanPath(username), "utf8"));
      const allowed = new Set(["ready", "blocked", "confirmed"]);
      return {
        id: typeof parsed.id === "string" ? parsed.id : null,
        status: allowed.has(parsed.status) ? parsed.status : "blocked",
        message: typeof parsed.message === "string" ? parsed.message : "释放计划不可用。",
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
        confirmedAt: typeof parsed.confirmedAt === "string" ? parsed.confirmedAt : null,
        manifestUpdatedAt: typeof parsed.manifestUpdatedAt === "string" ? parsed.manifestUpdatedAt : null,
        eligibleCount: Math.max(0, Number(parsed.eligibleCount) || 0),
        eligibleBytes: Math.max(0, Number(parsed.eligibleBytes) || 0),
        failedCount: Math.max(0, Number(parsed.failedCount) || 0),
        files: cleanFullFiles(parsed.files).slice(0, 100),
        assets: cleanReleaseAssets(parsed.assets).slice(0, 500),
        failures: Array.isArray(parsed.failures) ? parsed.failures.filter(item => item && typeof item.relativePath === "string").slice(0, 100) : [],
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function createReleasePlan(username) {
    const [config, manifest, timeline] = await Promise.all([read(username), readFullManifest(username), readTimeline(username)]);
    if (!config.backupDirectory || !manifest.updatedAt || manifest.files.length === 0) {
      throw Object.assign(new Error("当前还没有经过 SHA-256 验证的本地文件。请先在“完整增量备份”中选择一个时间范围并完成备份。"), { status: 409 });
    }
    if (timeline.assets.length === 0) {
      throw Object.assign(new Error("现有时间统计是旧格式，缺少云端资产 ID。请先在“按时间统计与选择”中点击“刷新统计”，完成后再生成释放计划；不需要重新备份。"), { status: 409 });
    }
    const backupRoot = await realpath(config.backupDirectory);
    const eligible = [];
    const failures = [];
    for (const item of manifest.files) {
      try {
        const requested = resolve(backupRoot, item.relativePath);
        const lexical = relative(backupRoot, requested);
        if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) throw new Error("路径超出备份目录");
        const actual = await realpath(requested);
        const actualRelative = relative(backupRoot, actual);
        if (actualRelative.startsWith("..") || isAbsolute(actualRelative)) throw new Error("文件链接超出备份目录");
        const info = await stat(actual);
        if (!info.isFile() || info.size !== item.size || info.size <= 0) throw new Error("文件大小不一致");
        const sha256 = await sha256File(actual);
        if (sha256 !== item.sha256) throw new Error("SHA-256 不一致");
        eligible.push({ ...item, verifiedAt: new Date().toISOString() });
      } catch (error) {
        failures.push({ relativePath: item.relativePath, reason: error instanceof Error ? error.message : "校验失败" });
      }
    }
    const createdAt = new Date().toISOString();
    const eligibleByName = new Map();
    for (const file of eligible) {
      const key = file.name.toLocaleLowerCase();
      const candidates = eligibleByName.get(key) || [];
      candidates.push(file);
      eligibleByName.set(key, candidates);
    }
    const matchedAssets = timeline.assets.flatMap(asset => {
      const created = new Date(asset.created);
      const yearMonth = `${created.getFullYear()}/${String(created.getMonth() + 1).padStart(2, "0")}`;
      const mainMatches = (eligibleByName.get(asset.name.toLocaleLowerCase()) || []).filter(file => file.size === asset.mainBytes && file.relativePath.replaceAll("\\", "/").includes(yearMonth));
      if (mainMatches.length !== 1) return [];
      if (!asset.livePhoto || asset.livePhotoBytes === 0) return [{ ...asset, localFiles: [mainMatches[0].relativePath] }];
      const stem = asset.name.replace(/\.[^.]+$/, "").toLocaleLowerCase();
      const liveMatches = eligible.filter(file => file.extension === "mov" && file.size === asset.livePhotoBytes && file.name.replace(/\.[^.]+$/, "").toLocaleLowerCase() === stem && file.relativePath.replaceAll("\\", "/").includes(yearMonth));
      return liveMatches.length === 1 ? [{ ...asset, localFiles: [mainMatches[0].relativePath, liveMatches[0].relativePath] }] : [];
    });
    const ready = failures.length === 0 && eligible.length === manifest.files.length;
    const plan = {
      version: 1, id: randomUUID(), status: ready ? "ready" : "blocked",
      message: ready ? `已重新校验本地清单中的 ${eligible.length} 个文件；${matchedAssets.length} 个云端项目完成精确匹配，可以进入人工释放确认。` : `${failures.length} 个本地文件未通过复核，禁止释放 iCloud 内容。`,
      createdAt, confirmedAt: null, manifestUpdatedAt: manifest.updatedAt,
      eligibleCount: eligible.length, eligibleBytes: eligible.reduce((sum, item) => sum + item.size, 0),
      failedCount: failures.length, files: eligible, assets: matchedAssets, failures,
    };
    await atomicJson(username, releasePlanPath(username), plan);
    return readReleasePlan(username);
  }

  async function confirmReleasePlan(username, planId, confirmation) {
    const plan = await readReleasePlan(username);
    const manifest = await readFullManifest(username);
    if (!plan || plan.status !== "ready" || plan.id !== planId || plan.manifestUpdatedAt !== manifest.updatedAt) {
      throw Object.assign(new Error("释放计划已失效，请重新生成并校验。"), { status: 409 });
    }
    if (confirmation !== "确认本地备份完整") throw Object.assign(new Error("确认文字不正确。"), { status: 400 });
    const raw = JSON.parse(await readFile(releasePlanPath(username), "utf8"));
    const confirmed = { ...raw, status: "confirmed", confirmedAt: new Date().toISOString(), message: raw.assets?.length ? `本地副本已确认完整；${raw.assets.length} 个云端项目已通过精确匹配，可在图片库手动移入“最近删除”。` : "本地副本已确认完整；当前清单尚未精确关联云端项目，请先刷新时间统计后重新生成计划。" };
    await atomicJson(username, releasePlanPath(username), confirmed);
    return readReleasePlan(username);
  }

  async function readReleaseHistory(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(releaseHistoryPath(username), "utf8"));
      const events = Array.isArray(parsed.events) ? parsed.events.filter(item => item && typeof item.completedAt === "string").slice(-500) : [];
      return { movedCount: Math.max(0, Number(parsed.movedCount) || 0), movedBytes: Math.max(0, Number(parsed.movedBytes) || 0), recycledFileCount: Math.max(0, Number(parsed.recycledFileCount) || 0), recycledBytes: Math.max(0, Number(parsed.recycledBytes) || 0), lastReleasedAt: typeof parsed.lastReleasedAt === "string" ? parsed.lastReleasedAt : null, events };
    } catch (error) {
      if (error.code === "ENOENT") return { movedCount: 0, movedBytes: 0, recycledFileCount: 0, recycledBytes: 0, lastReleasedAt: null, events: [] };
      throw error;
    }
  }

  async function prepareLocalPaths(username, relativePaths) {
    const [config, manifest] = await Promise.all([read(username), readFullManifest(username)]);
    if (!config.backupDirectory) throw Object.assign(new Error("尚未设置本地备份目录。"), { status: 409 });
    const byPath = new Map(manifest.files.map(file => [file.relativePath, file]));
    const backupRoot = await realpath(config.backupDirectory);
    const files = [];
    for (const relativePath of relativePaths) {
      const manifestFile = byPath.get(relativePath);
      if (!manifestFile?.sha256) throw Object.assign(new Error(`本地完整性清单缺少 ${relativePath}。`), { status: 409 });
      const requested = resolve(backupRoot, relativePath);
      const lexical = relative(backupRoot, requested);
      if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) throw Object.assign(new Error("本地文件路径超出备份目录。"), { status: 409 });
      const actual = await realpath(requested);
      const actualRelative = relative(backupRoot, actual);
      if (actualRelative.startsWith("..") || isAbsolute(actualRelative)) throw Object.assign(new Error("本地文件链接超出备份目录。"), { status: 409 });
      const info = await stat(actual);
      if (!info.isFile() || info.size !== manifestFile.size || await sha256File(actual) !== manifestFile.sha256) throw Object.assign(new Error(`本地文件 ${relativePath} 未通过 SHA-256 复核。`), { status: 409 });
      files.push({ path: actual, relativePath, size: manifestFile.size });
    }
    return { files, fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  }

  async function prepareLocalRecycle(username, requestedAssets) {
    const plan = await readReleasePlan(username);
    if (!plan || plan.status !== "confirmed") throw Object.assign(new Error("释放计划尚未确认。"), { status: 409 });
    const requestedKeys = new Set(cleanTimelineAssets(requestedAssets).map(asset => `${asset.library}:${asset.id}`));
    const relativePaths = [...new Set(plan.assets.filter(asset => requestedKeys.has(`${asset.library}:${asset.id}`)).flatMap(asset => asset.localFiles))];
    if (!relativePaths.length) throw Object.assign(new Error("没有找到与云端项目精确关联的本地原文件。"), { status: 409 });
    return prepareLocalPaths(username, relativePaths);
  }

  async function prepareRecycleRetry(username, eventId) {
    const history = await readReleaseHistory(username);
    const event = history.events.find(item => item.id === eventId);
    const failedPaths = Array.isArray(event?.recycleResults) ? event.recycleResults.filter(item => item.status === "failed").map(item => item.relativePath) : [];
    if (!failedPaths.length) throw Object.assign(new Error("这条记录没有可重试的本地文件。"), { status: 409 });
    return prepareLocalPaths(username, failedPaths);
  }

  async function recordReleasedAssets(username, requestedAssets, result, recycleResult = null) {
    const deletedKeys = new Set((result.results || []).filter(item => item.status === "deleted").map(item => `${item.library}:${item.id}`));
    const current = await readReleaseHistory(username);
    const previouslyDeleted = new Set(current.events.flatMap(event => Array.isArray(event.assets) ? event.assets.map(asset => `${asset.library}:${asset.id}`) : []));
    const deletedAssets = cleanTimelineAssets(requestedAssets).filter(asset => deletedKeys.has(`${asset.library}:${asset.id}`) && !previouslyDeleted.has(`${asset.library}:${asset.id}`));
    if (!deletedAssets.length) return current;
    const completedAt = new Date().toISOString();
    const movedBytes = deletedAssets.reduce((sum, asset) => sum + asset.originalBytes, 0);
    const recycled = Array.isArray(recycleResult?.results) ? recycleResult.results.filter(item => item.status === "recycled") : [];
    const recycledBytes = recycled.reduce((sum, item) => sum + Math.max(0, Number(item.size) || 0), 0);
    const history = { version: 2, movedCount: current.movedCount + deletedAssets.length, movedBytes: current.movedBytes + movedBytes, recycledFileCount: current.recycledFileCount + recycled.length, recycledBytes: current.recycledBytes + recycledBytes, lastReleasedAt: completedAt, events: [...current.events, { id: randomUUID(), completedAt, count: deletedAssets.length, bytes: movedBytes, recycledFileCount: recycled.length, recycledBytes, recycleStatus: recycleResult?.status || "not_requested", recycleResults: Array.isArray(recycleResult?.results) ? recycleResult.results : [], assets: deletedAssets.map(asset => ({ id: asset.id, library: asset.library, name: asset.name })) }].slice(-500) };
    await atomicJson(username, releaseHistoryPath(username), history);
    await removeRecycledFromManifest(username, recycleResult?.results);
    try {
      const plan = JSON.parse(await readFile(releasePlanPath(username), "utf8"));
      plan.assets = cleanReleaseAssets(plan.assets).filter(asset => !deletedKeys.has(`${asset.library}:${asset.id}`));
      plan.message = plan.assets.length ? `${plan.assets.length} 个精确匹配项目仍可在图片库手动释放。` : "本次释放计划中的精确匹配项目已全部处理；请重新统计后生成下一份计划。";
      await atomicJson(username, releasePlanPath(username), plan);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const timeline = await readTimeline(username);
    const remaining = timeline.assets.filter(asset => !deletedKeys.has(`${asset.library}:${asset.id}`));
    const buckets = { years: new Map(), quarters: new Map(), months: new Map() };
    const add = (map, key, asset) => {
      const bucket = map.get(key) || { key, itemCount: 0, photoCount: 0, videoCount: 0, livePhotoCount: 0, rawCount: 0, originalBytes: 0 };
      bucket.itemCount += 1; bucket.originalBytes += asset.originalBytes;
      if (asset.mediaType === "video") bucket.videoCount += 1; else bucket.photoCount += 1;
      if (asset.livePhoto) bucket.livePhotoCount += 1; if (asset.raw) bucket.rawCount += 1;
      map.set(key, bucket);
    };
    for (const asset of remaining) {
      const date = new Date(asset.created); const year = date.getFullYear(); const month = date.getMonth() + 1;
      add(buckets.years, String(year), asset); add(buckets.quarters, `${year}-Q${Math.floor((month - 1) / 3) + 1}`, asset); add(buckets.months, `${year}-${String(month).padStart(2, "0")}`, asset);
    }
    const total = remaining.reduce((bucket, asset) => { add(new Map([["total", bucket]]), "total", asset); return bucket; }, { key: "total", itemCount: 0, photoCount: 0, videoCount: 0, livePhotoCount: 0, rawCount: 0, originalBytes: 0 });
    const newest = map => [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
    await atomicJson(username, timelinePath(username), { version: 2, scannedAt: timeline.scannedAt, staleAt: completedAt, staleReason: "已从 iCloud 移入最近删除；当前数字已在本地扣除，请重新统计以确认云端状态。", total, years: newest(buckets.years), quarters: newest(buckets.quarters), months: newest(buckets.months), assets: remaining });
    return readReleaseHistory(username);
  }

  async function recordRecycleRetry(username, eventId, recycleResult) {
    const current = await readReleaseHistory(username);
    const eventIndex = current.events.findIndex(event => event.id === eventId);
    if (eventIndex < 0) throw Object.assign(new Error("找不到本地回收记录。"), { status: 404 });
    const event = current.events[eventIndex];
    const previousResults = Array.isArray(event.recycleResults) ? event.recycleResults : [];
    const retryByPath = new Map((recycleResult.results || []).map(result => [result.relativePath, result]));
    const nextResults = previousResults.map(result => result.status === "failed" && retryByPath.has(result.relativePath) ? retryByPath.get(result.relativePath) : result);
    const newlyRecycled = nextResults.filter((result, index) => result.status === "recycled" && previousResults[index]?.status !== "recycled");
    const addedBytes = newlyRecycled.reduce((sum, result) => sum + Math.max(0, Number(result.size) || 0), 0);
    const allRecycled = nextResults.length > 0 && nextResults.every(result => result.status === "recycled");
    current.events[eventIndex] = { ...event, recycleResults: nextResults, recycleStatus: allRecycled ? "recycled" : nextResults.some(result => result.status === "recycled") ? "partial" : "failed", recycledFileCount: nextResults.filter(result => result.status === "recycled").length, recycledBytes: nextResults.filter(result => result.status === "recycled").reduce((sum, result) => sum + Math.max(0, Number(result.size) || 0), 0) };
    const updated = { version: 2, movedCount: current.movedCount, movedBytes: current.movedBytes, recycledFileCount: current.recycledFileCount + newlyRecycled.length, recycledBytes: current.recycledBytes + addedBytes, lastReleasedAt: current.lastReleasedAt, events: current.events };
    await atomicJson(username, releaseHistoryPath(username), updated);
    await removeRecycledFromManifest(username, recycleResult?.results);
    return readReleaseHistory(username);
  }

  async function readScan(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(manifestPath(username), "utf8"));
      const samples = Array.isArray(parsed.samples) ? parsed.samples.filter(item => item && typeof item.name === "string" && manifestExtensions.has(String(item.extension || "").toLowerCase())).slice(0, 25) : [];
      return {
        scannedAt: typeof parsed.scannedAt === "string" ? parsed.scannedAt : null,
        sampleCount: samples.length,
        samples,
      };
    } catch (error) {
      if (error.code === "ENOENT") return { scannedAt: null, sampleCount: 0, samples: [] };
      throw error;
    }
  }

  async function readBackup(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(backupResultPath(username), "utf8"));
      const files = Array.isArray(parsed.files) ? parsed.files.filter(item => item && typeof item.name === "string" && Number(item.size) > 0).slice(0, 100).map(item => ({
        name: item.name,
        relativePath: typeof item.relativePath === "string" ? item.relativePath : item.name,
        extension: String(item.extension || "").toLowerCase(),
        mediaType: item.mediaType === "video" ? "video" : "photo",
        size: Number(item.size),
        sha256: /^[a-f0-9]{64}$/.test(String(item.sha256 || "")) ? item.sha256 : null,
      })) : [];
      return { completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null, fileCount: files.length, files };
    } catch (error) {
      if (error.code === "ENOENT") return { completedAt: null, fileCount: 0, files: [] };
      throw error;
    }
  }

  async function read(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(configPath(username), "utf8"));
      return {
        ...emptyConfig(),
        selectedDirectory: typeof parsed.selectedDirectory === "string" ? parsed.selectedDirectory : null,
        backupDirectory: typeof parsed.backupDirectory === "string" ? parsed.backupDirectory : null,
        provider: "icloudpd",
        connectionStatus: parsed.connectionStatus === "connected" || parsed.connectionStatus === "expired" ? parsed.connectionStatus : "not_connected",
        appleAccount: typeof parsed.appleAccount === "string" ? parsed.appleAccount : null,
        icloudDomain: parsed.icloudDomain === "com" ? "com" : "cn",
        lastConnectionCheckAt: typeof parsed.lastConnectionCheckAt === "string" ? parsed.lastConnectionCheckAt : null,
        lastConnectionMessage: typeof parsed.lastConnectionMessage === "string" ? parsed.lastConnectionMessage : null,
        lastScanAt: typeof parsed.lastScanAt === "string" ? parsed.lastScanAt : null,
        lastBackupAt: typeof parsed.lastBackupAt === "string" ? parsed.lastBackupAt : null,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      };
    } catch (error) {
      if (error.code === "ENOENT") return emptyConfig();
      throw error;
    }
  }

  async function save(username, config) {
    const directory = userDirectory(username);
    const destination = configPath(username);
    const temporary = `${destination}.tmp`;
    const task = writes.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, destination);
    });
    writes = task.catch(() => undefined);
    await task;
  }

  async function configureBackupDirectory(username, selectedPath) {
    validateUsername(username);
    if (typeof selectedPath !== "string" || !selectedPath.trim() || selectedPath.length > 4096 || !isAbsolute(selectedPath.trim())) {
      throw Object.assign(new Error("请选择有效的绝对文件夹路径。"), { status: 400 });
    }
    let selectedRoot;
    try {
      selectedRoot = await realpath(resolve(selectedPath.trim()));
      if (!(await stat(selectedRoot)).isDirectory()) throw new Error("not-directory");
    } catch {
      throw Object.assign(new Error("找不到这个文件夹，或 FrameBase 没有读取权限。"), { status: 400 });
    }

    const requestedDirectory = join(selectedRoot, "FrameBase-iCloud", username);
    await mkdir(requestedDirectory, { recursive: true });
    const backupDirectory = await realpath(requestedDirectory);
    const escape = relative(selectedRoot, backupDirectory);
    if (escape.startsWith("..") || isAbsolute(escape)) {
      throw Object.assign(new Error("备份目录超出了所选文件夹。"), { status: 400 });
    }

    const config = { ...await read(username), selectedDirectory: selectedRoot, backupDirectory, updatedAt: new Date().toISOString() };
    await save(username, config);
    return config;
  }

  async function configureConnection(username, input) {
    validateUsername(username);
    const appleAccount = typeof input?.appleAccount === "string" ? input.appleAccount.trim().toLowerCase() : "";
    const icloudDomain = input?.icloudDomain === "com" ? "com" : input?.icloudDomain === "cn" ? "cn" : "";
    if (!appleAccount || appleAccount.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(appleAccount)) {
      throw Object.assign(new Error("请输入有效的 Apple ID 邮箱地址。"), { status: 400 });
    }
    if (!icloudDomain) throw Object.assign(new Error("请选择 iCloud 服务区域。"), { status: 400 });
    const current = await read(username);
    if (!current.backupDirectory) throw Object.assign(new Error("请先设置备份目录。"), { status: 400 });
    const changed = current.appleAccount !== appleAccount || current.icloudDomain !== icloudDomain;
    await mkdir(join(userDirectory(username), "session"), { recursive: true });
    const config = {
      ...current,
      provider: "icloudpd",
      appleAccount,
      icloudDomain,
      connectionStatus: changed ? "not_connected" : current.connectionStatus,
      lastConnectionCheckAt: changed ? null : current.lastConnectionCheckAt,
      lastConnectionMessage: changed ? null : current.lastConnectionMessage,
      updatedAt: new Date().toISOString(),
    };
    await save(username, config);
    return config;
  }

  async function connectionContext(username) {
    const config = await read(username);
    if (!config.backupDirectory) throw Object.assign(new Error("请先设置备份目录。"), { status: 400 });
    if (!config.appleAccount) throw Object.assign(new Error("请先保存 Apple ID 和服务区域。"), { status: 400 });
    const sessionDirectory = join(userDirectory(username), "session");
    await mkdir(sessionDirectory, { recursive: true });
    return { appleAccount: config.appleAccount, domain: config.icloudDomain, sessionDirectory, backupDirectory: config.backupDirectory };
  }

  async function recordConnectionCheck(username, result) {
    const current = await read(username);
    const config = {
      ...current,
      connectionStatus: result.status === "connected" ? "connected" : "expired",
      lastConnectionCheckAt: new Date().toISOString(),
      lastConnectionMessage: result.message,
      updatedAt: new Date().toISOString(),
    };
    await save(username, config);
    return config;
  }

  async function recordScan(username, result) {
    validateUsername(username);
    const scannedAt = new Date().toISOString();
    const samples = Array.isArray(result.samples) ? result.samples.slice(0, 25).map(item => ({
      name: String(item.name || ""),
      extension: String(item.extension || ""),
      mediaType: item.mediaType === "video" ? "video" : "photo",
    })) : [];
    const directory = userDirectory(username);
    const destination = manifestPath(username);
    const temporary = `${destination}.tmp`;
    const task = writes.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, `${JSON.stringify({ version: 1, scannedAt, sampleCount: samples.length, samples }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, destination);
    });
    writes = task.catch(() => undefined);
    await task;
    const config = { ...await read(username), lastScanAt: scannedAt, updatedAt: scannedAt };
    await save(username, config);
    return { ...config, scan: { scannedAt, sampleCount: samples.length, samples } };
  }

  async function recordBackup(username, result) {
    validateUsername(username);
    const completedAt = new Date().toISOString();
    const newFiles = Array.isArray(result.files) ? result.files.slice(0, 10).map(item => ({
      name: String(item.name || ""),
      relativePath: String(item.relativePath || item.name || ""),
      extension: String(item.extension || "").toLowerCase(),
      mediaType: item.mediaType === "video" ? "video" : "photo",
      size: Math.max(0, Number(item.size) || 0),
      sha256: /^[a-f0-9]{64}$/.test(String(item.sha256 || "")) ? item.sha256 : null,
    })).filter(item => item.name && item.size > 0) : [];
    const previous = await readBackup(username);
    const filesByPath = new Map(previous.files.map(item => [item.relativePath, item]));
    for (const file of newFiles) filesByPath.set(file.relativePath, file);
    const files = [...filesByPath.values()].slice(0, 100);
    const directory = userDirectory(username);
    const destination = backupResultPath(username);
    const temporary = `${destination}.tmp`;
    const task = writes.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, `${JSON.stringify({ version: 1, completedAt, fileCount: files.length, files }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, destination);
    });
    writes = task.catch(() => undefined);
    await task;
    const config = { ...await read(username), lastBackupAt: completedAt, updatedAt: completedAt };
    await save(username, config);
    return { ...config, backup: { completedAt, fileCount: files.length, files } };
  }

  return { read, readScan, readBackup, readFullBackup, readFullManifest, readBackupCoverage, writeFullBackup, writeFullManifest, readTimeline, recordTimeline, readBackupHistory, recordCompletedRanges, readReleasePlan, createReleasePlan, confirmReleasePlan, readReleaseHistory, prepareLocalRecycle, prepareRecycleRetry, recordReleasedAssets, recordRecycleRetry, configureBackupDirectory, configureConnection, connectionContext, recordConnectionCheck, recordScan, recordBackup };
}
