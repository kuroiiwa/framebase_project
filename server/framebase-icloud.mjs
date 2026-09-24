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

  return { read, readScan, configureBackupDirectory, configureConnection, connectionContext, recordConnectionCheck, recordScan };
}
