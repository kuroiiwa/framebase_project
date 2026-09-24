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
        planned: Math.max(0, Number(parsed.planned) || 0),
        downloaded: Math.max(0, Number(parsed.downloaded) || 0),
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
      if (error.code === "ENOENT") return { status: "idle", message: "尚未开始完整备份。", startedAt: null, updatedAt: null, completedAt: null, phase: "idle", currentLibrary: null, planned: 0, downloaded: 0, verified: 0, skipped: 0, failed: 0, photoCount: 0, videoCount: 0, verifiedBytes: 0, manifestFileCount: 0, ranges: [] };
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

  function cleanTimelineBuckets(value) {
    return Array.isArray(value) ? value.map(item => ({
      key: String(item?.key || ""), itemCount: Math.max(0, Number(item?.itemCount) || 0),
      photoCount: Math.max(0, Number(item?.photoCount) || 0), videoCount: Math.max(0, Number(item?.videoCount) || 0),
      livePhotoCount: Math.max(0, Number(item?.livePhotoCount) || 0), rawCount: Math.max(0, Number(item?.rawCount) || 0),
      originalBytes: Math.max(0, Number(item?.originalBytes) || 0),
    })).filter(item => item.key && item.itemCount > 0).slice(0, 500) : [];
  }

  async function readTimeline(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(timelinePath(username), "utf8"));
      return {
        scannedAt: typeof parsed.scannedAt === "string" ? parsed.scannedAt : null,
        total: cleanTimelineBuckets([parsed.total])[0] || null,
        years: cleanTimelineBuckets(parsed.years), quarters: cleanTimelineBuckets(parsed.quarters), months: cleanTimelineBuckets(parsed.months),
      };
    } catch (error) {
      if (error.code === "ENOENT") return { scannedAt: null, total: null, years: [], quarters: [], months: [] };
      throw error;
    }
  }

  async function recordTimeline(username, result) {
    const timeline = {
      version: 1, scannedAt: typeof result.scannedAt === "string" ? result.scannedAt : new Date().toISOString(),
      total: cleanTimelineBuckets([result.total])[0] || null,
      years: cleanTimelineBuckets(result.years), quarters: cleanTimelineBuckets(result.quarters), months: cleanTimelineBuckets(result.months),
    };
    await atomicJson(username, timelinePath(username), timeline);
    return timeline;
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
        failures: Array.isArray(parsed.failures) ? parsed.failures.filter(item => item && typeof item.relativePath === "string").slice(0, 100) : [],
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function createReleasePlan(username) {
    const [config, fullBackup, manifest] = await Promise.all([read(username), readFullBackup(username), readFullManifest(username)]);
    if (!config.backupDirectory || fullBackup.status !== "completed" || !manifest.updatedAt || manifest.files.length === 0) {
      throw Object.assign(new Error("请先完成一次完整增量备份和 SHA-256 校验。"), { status: 409 });
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
    const ready = failures.length === 0 && eligible.length === manifest.files.length;
    const plan = {
      version: 1, id: randomUUID(), status: ready ? "ready" : "blocked",
      message: ready ? `已重新校验 ${eligible.length} 个本地文件；可以进入人工释放确认。` : `${failures.length} 个本地文件未通过复核，禁止释放 iCloud 内容。`,
      createdAt, confirmedAt: null, manifestUpdatedAt: manifest.updatedAt,
      eligibleCount: eligible.length, eligibleBytes: eligible.reduce((sum, item) => sum + item.size, 0),
      failedCount: failures.length, files: eligible, failures,
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
    const confirmed = { ...JSON.parse(await readFile(releasePlanPath(username), "utf8")), status: "confirmed", confirmedAt: new Date().toISOString(), message: "本地副本已确认完整；自动云端删除仍保持锁定。" };
    await atomicJson(username, releasePlanPath(username), confirmed);
    return readReleasePlan(username);
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

  return { read, readScan, readBackup, readFullBackup, readFullManifest, writeFullBackup, writeFullManifest, readTimeline, recordTimeline, readReleasePlan, createReleasePlan, confirmReleasePlan, configureBackupDirectory, configureConnection, connectionContext, recordConnectionCheck, recordScan, recordBackup };
}
