import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { createPowerManager, isLocalAdmin, validatePowerRequest } from "./framebase-power.mjs";
import { createAccounts } from "./framebase-accounts.mjs";
import { createIcloudManager } from "./framebase-icloud.mjs";
import { createIcloudPdProvider } from "./icloud-providers/icloudpd-provider.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(projectRoot, ".framebase-lan.json");
const thumbnailDirectory = join(projectRoot, ".framebase-thumbnails");
const accounts = createAccounts(join(projectRoot, ".framebase-accounts.json"));
const icloud = createIcloudManager({ projectRoot });
const bundledIcloudPdPath = join(projectRoot, "tools", "icloudpd", "icloudpd-1.32.3-windows-amd64.exe");
const compatibleIcloudPdPath = join(projectRoot, "tools", "icloudpd", "icloudpd-framebase-compatible.exe");
const icloudProvider = createIcloudPdProvider({
  executablePath: resolve(
    process.env.FRAMEBASE_ICLOUDPD_PATH
      || (existsSync(compatibleIcloudPdPath) ? compatibleIcloudPdPath : bundledIcloudPdPath),
  ),
});
const icloudBackupUsers = new Set();
const icloudFullBackupJobs = new Map();
const mobileSessions = new Map();
const publicPort = Number(process.env.FRAMEBASE_LAN_PORT || 3000);
const appPort = Number(process.env.FRAMEBASE_APP_PORT || 3001);
const appHost = "127.0.0.1";
const videoExtensions = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "wmv", "flv", "mpeg", "mpg"]);
const mimeTypes = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mkv: "video/x-matroska", avi: "video/x-msvideo", wmv: "video/x-ms-wmv",
  flv: "video/x-flv", mpeg: "video/mpeg", mpg: "video/mpeg",
};

const indexCaches = new Map();
const indexingPromises = new Map();
const pairingAttempts = new Map();
const powerManagers = new Map();
function powerManagerFor(username) {
  if (!powerManagers.has(username)) powerManagers.set(username, createPowerManager({
    path: join(projectRoot, username === "gabri" ? ".framebase-power.json" : `.framebase-power-${username}.json`),
    readPairingToken: async () => (await readConfig(username)).accessToken,
  }));
  return powerManagers.get(username);
}

function requirePc(request, response) {
  const current = isLocalAdmin(request) ? accounts.session(request) : null;
  if (!current) json(response, 401, { error: "请先在电脑端登录账户。" });
  else if (request.method !== "GET" && request.method !== "HEAD" && request.headers.origin !== `http://${request.headers.host}`) {
    json(response, 403, { error: "请从 Framebase 页面发起操作。" });
    return null;
  }
  return current;
}

function mobileSession(request) {
  const token = cookieValue(request, "framebase_lan_session");
  const current = mobileSessions.get(token);
  if (!current || !accounts.hasSession(current.pcToken)) return null;
  return current;
}

async function handleAccount(request, response, url) {
  if (!isLocalAdmin(request)) return json(response, 403, { error: "账户操作只能在这台电脑上进行。" });
  if (request.method === "POST" && request.headers.origin !== `http://${request.headers.host}`) return json(response, 403, { error: "请从 Framebase 页面发起操作。" });
  if (request.method === "GET" && url.pathname === "/api/account/session") {
    const current = accounts.session(request);
    const data = await accounts.read();
    return json(response, 200, { user: current?.username || null, needsSetup: !data.users.some(item => item.username === "admin") });
  }
  if (request.method === "POST" && ["/api/account/setup", "/api/account/register", "/api/account/login"].includes(url.pathname)) {
    const body = await readJsonBody(request);
    const username = String(body.username || "").trim().toLowerCase();
    const password = body.password;
    const token = url.pathname === "/api/account/login" ? await accounts.login(username, password, request.socket.remoteAddress) : await accounts.register(username, password, url.pathname === "/api/account/setup");
    const previous = accounts.logout(request);
    if (previous) {
      for (const [mobileToken, mobile] of mobileSessions) if (mobile.pcToken === previous.token) mobileSessions.delete(mobileToken);
      powerManagers.get(previous.username)?.stop();
    }
    return json(response, 200, { user: username }, { "Set-Cookie": accounts.cookie(token) });
  }
  if (request.method === "POST" && url.pathname === "/api/account/logout") {
    const current = accounts.logout(request);
    if (current) {
      for (const [token, mobile] of mobileSessions) if (mobile.pcToken === current.token) mobileSessions.delete(token);
      powerManagers.get(current.username)?.stop();
    }
    return json(response, 200, { ok: true }, { "Set-Cookie": "framebase_account=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }
  const current = requirePc(request, response);
  if (!current) return;
  if (request.method === "POST" && url.pathname === "/api/account/summary") {
    const body = await readJsonBody(request);
    if (!Array.isArray(body.sources) || body.sources.length > 1000) return json(response, 400, { error: "源文件夹信息无效。" });
    await accounts.updateSummary(current.username, body.sources);
    return json(response, 200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/account/users") {
    if (current.username !== "admin") return json(response, 403, { error: "仅管理员可以查看。" });
    const data = await accounts.read();
    return json(response, 200, { users: data.users.map(({ username, sources, videoCount, totalSize }) => ({ username, sources, videoCount, totalSize })) });
  }
  return json(response, 405, { error: "不支持的操作。" });
}

async function handlePower(request, response, url) {
  try {
    validatePowerRequest(request);
    const pc = isLocalAdmin(request) ? accounts.session(request) : null;
    const mobile = mobileSession(request);
    const admin = Boolean(pc);
    const paired = Boolean(mobile);
    if (!admin && !paired) return json(response, 401, { error: "请先输入配对验证码进入视频库。" });
    const powerManager = powerManagerFor((pc || mobile).username);
    const secret = cookieValue(request, "framebase_power_device");
    if (request.method === "GET" && url.pathname === "/api/lan/power") return json(response, 200, await powerManager.status(secret, admin));
    if (request.method !== "POST") return json(response, 405, { error: "不支持的操作。" });
    const action = url.pathname.slice("/api/lan/power/".length);
    const result = await powerManager.action(action, await readJsonBody(request), { secret, admin, paired });
    return json(response, 200, result.data, result.cookie ? { "Set-Cookie": `framebase_power_device=${result.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` } : {});
  } catch (error) { return json(response, error.status || 500, { error: error.message || "远程关机操作失败。" }); }
}

function createPairingCode() {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function userConfigPath(username) { return join(projectRoot, `.framebase-lan-${username}.json`); }
function userThumbnailDirectory(username) { return join(thumbnailDirectory, username); }

async function readConfig(username) {
  const path = userConfigPath(username);
  try {
    let parsed;
    let migrated = false;
    try { parsed = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT" || username !== "gabri") throw error;
      parsed = JSON.parse(await readFile(configPath, "utf8"));
      migrated = true;
    }
    const config = {
      accessToken: typeof parsed.accessToken === "string" && parsed.accessToken.length >= 16 ? parsed.accessToken : randomBytes(18).toString("base64url"),
      pairingCode: typeof parsed.pairingCode === "string" && /^\d{6}$/.test(parsed.pairingCode) ? parsed.pairingCode : createPairingCode(),
      videoFolders: Array.isArray(parsed.videoFolders) ? parsed.videoFolders.filter(value => typeof value === "string") : [],
    };
    if (migrated || config.accessToken !== parsed.accessToken || config.pairingCode !== parsed.pairingCode) await saveConfig(username, config);
    return config;
  } catch {
    const config = { accessToken: randomBytes(18).toString("base64url"), pairingCode: createPairingCode(), videoFolders: [] };
    await saveConfig(username, config);
    return config;
  }
}

async function saveConfig(username, config) {
  const path = userConfigPath(username);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  indexCaches.delete(username);
}

function isLoopback(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function safeEqual(left, right) {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function cookieValue(request, name) {
  for (const part of String(request.headers.cookie || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function videoId(path) {
  return createHash("sha256").update(path).digest("hex").slice(0, 32);
}

async function configuredRoots(config) {
  const roots = [];
  for (const configuredPath of config.videoFolders) {
    try {
      const absolutePath = await realpath(resolve(configuredPath));
      const info = await stat(absolutePath);
      if (info.isDirectory()) roots.push({ path: absolutePath, name: basename(absolutePath) || absolutePath });
    } catch { /* Missing or inaccessible folders are reported by the settings endpoint. */ }
  }
  return roots;
}

async function walkVideos(root, directory, output) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walkVideos(root, absolutePath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).slice(1).toLowerCase();
    if (!videoExtensions.has(ext)) continue;
    try {
      const info = await stat(absolutePath);
      const pathWithinRoot = relative(root.path, absolutePath).split("\\").join("/");
      output.push({
        id: videoId(absolutePath), absolutePath, name: entry.name, ext, size: info.size,
        modified: info.mtimeMs, sourceName: root.name, path: pathWithinRoot,
      });
    } catch { /* Files that disappear during a scan are skipped. */ }
  }
}

async function buildIndex(username, force = false) {
  let indexCache = indexCaches.get(username) || { signature: "", expires: 0, videos: [], byId: new Map() };
  if (!force && indexCache.expires > 0) {
    if (indexCache.expires <= Date.now() && !indexingPromises.has(username)) {
      void buildIndex(username, true).catch(error => {
        indexCache.expires = Date.now() + 20_000;
        console.error("后台更新视频索引失败", error);
      });
    }
    return indexCache;
  }
  if (indexingPromises.has(username)) return indexingPromises.get(username);
  const indexingPromise = (async () => {
    const config = await readConfig(username);
    const roots = await configuredRoots(config);
    const signature = roots.map(root => root.path).join("\n");
    if (!force && indexCache.signature === signature && indexCache.expires > Date.now()) return indexCache;
    const videos = [];
    for (const root of roots) await walkVideos(root, root.path, videos);
    videos.sort((a, b) => b.modified - a.modified);
    indexCache = { signature, expires: Date.now() + 20_000, videos, byId: new Map(videos.map(video => [video.id, video])) };
    indexCaches.set(username, indexCache);
    return indexCache;
  })();
  indexingPromises.set(username, indexingPromise);
  try { return await indexingPromise; } finally { indexingPromises.delete(username); }
}

function accessUrls() {
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) urls.push(`http://${address.address}:${publicPort}/mobile`);
    }
  }
  return [...new Set(urls)];
}

async function folderDetails(config) {
  return Promise.all(config.videoFolders.map(async configuredPath => {
    try {
      const absolutePath = await realpath(resolve(configuredPath));
      const info = await stat(absolutePath);
      return { path: configuredPath, name: basename(absolutePath) || absolutePath, available: info.isDirectory() };
    } catch { return { path: configuredPath, name: basename(configuredPath) || configuredPath, available: false }; }
  }));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readBinaryBody(request, maximumSize = 2_500_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumSize) throw new Error("缩略图文件过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function pickWindowsFolder(expectedSource = "") {
  return new Promise((resolvePromise, rejectPromise) => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
      "$owner.Size = New-Object System.Drawing.Size(1, 1)",
      "$owner.ShowInTaskbar = $false",
      "$owner.TopMost = $true",
      "$owner.Opacity = 0",
      "$owner.Show()",
      "$owner.Activate()",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$name = $env:FRAMEBASE_EXPECTED_SOURCE",
      "$dialog.Description = if ($name) { '请选择与缓存来源“' + $name + '”对应的文件夹' } else { '请选择要共享给手机浏览的文件夹' }",
      "$dialog.ShowNewFolderButton = $false",
      "$result = $dialog.ShowDialog($owner)",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "  [Console]::Out.Write($dialog.SelectedPath)",
      "}",
      "$dialog.Dispose()",
      "$owner.Close()",
      "$owner.Dispose()",
    ].join("\n");
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-Command", script], {
      encoding: "utf8",
      env: { ...process.env, FRAMEBASE_EXPECTED_SOURCE: expectedSource },
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) return rejectPromise(error);
      resolvePromise(stdout.trim() || null);
    });
  });
}

function pickWindowsBackupFolder() {
  return new Promise((resolvePromise, rejectPromise) => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
      "$owner.Size = New-Object System.Drawing.Size(1, 1)",
      "$owner.ShowInTaskbar = $false",
      "$owner.TopMost = $true",
      "$owner.Opacity = 0",
      "$owner.Show()",
      "$owner.Activate()",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '请选择 iCloud 备份的上级文件夹。FrameBase 会在其中创建按用户隔离的目录。'",
      "$dialog.ShowNewFolderButton = $true",
      "$result = $dialog.ShowDialog($owner)",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "  [Console]::Out.Write($dialog.SelectedPath)",
      "}",
      "$dialog.Dispose()",
      "$owner.Close()",
      "$owner.Dispose()",
    ].join("\n");
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-Command", script], { encoding: "utf8", timeout: 10 * 60 * 1000, windowsHide: true }, (error, stdout) => {
      if (error) return rejectPromise(error);
      resolvePromise(stdout.trim() || null);
    });
  });
}

async function handleFolderPicker(request, response) {
  if (!requirePc(request, response)) return;
  if (request.method !== "POST") return json(response, 405, { error: "不支持的操作。" });
  if (process.platform !== "win32") return json(response, 501, { error: "自动选择文件夹目前仅支持 Windows，请手动输入完整路径。" });
  const body = await readJsonBody(request);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 160) : "";
  const selectedPath = await pickWindowsFolder(name);
  return json(response, 200, selectedPath ? { path: selectedPath } : { cancelled: true });
}

async function handleIcloud(request, response, url) {
  const current = requirePc(request, response);
  if (!current) return;
  if (request.method === "POST" && request.headers.origin !== `http://${request.headers.host}`) return json(response, 403, { error: "请从 Framebase 页面发起操作。" });
  if (request.method === "GET" && url.pathname === "/api/icloud/config") {
    const [config, scan, backup, fullBackupStored, timeline, releasePlan, providerInfo] = await Promise.all([icloud.read(current.username), icloud.readScan(current.username), icloud.readBackup(current.username), icloud.readFullBackup(current.username), icloud.readTimeline(current.username), icloud.readReleasePlan(current.username), icloudProvider.info()]);
    let fullBackup = fullBackupStored;
    if (["planning", "downloading", "verifying"].includes(fullBackup.status) && !icloudFullBackupJobs.has(current.username)) {
      fullBackup = await icloud.writeFullBackup(current.username, { status: "paused", phase: "paused", message: "FrameBase 曾在任务运行时停止；可点击继续以安全恢复。" });
    }
    return json(response, 200, {
      ...config,
      scan,
      backup,
      timeline,
      fullBackup,
      fullManifest: { updatedAt: fullBackup.updatedAt, fileCount: fullBackup.manifestFileCount },
      releasePlan,
      providerInfo: { id: providerInfo.id, available: providerInfo.available, version: providerInfo.version },
    });
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/pick-folder") {
    if (process.platform !== "win32") return json(response, 501, { error: "自动选择文件夹目前仅支持 Windows。" });
    const selectedPath = await pickWindowsBackupFolder();
    if (!selectedPath) return json(response, 200, { cancelled: true });
    return json(response, 200, await icloud.configureBackupDirectory(current.username, selectedPath));
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/config") {
    const body = await readJsonBody(request);
    return json(response, 200, await icloud.configureBackupDirectory(current.username, body.path));
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/connection") {
    const body = await readJsonBody(request);
    const [config, providerInfo] = await Promise.all([
      icloud.configureConnection(current.username, body),
      icloudProvider.info(),
    ]);
    return json(response, 200, { ...config, providerInfo: { id: providerInfo.id, available: providerInfo.available, version: providerInfo.version } });
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/verify") {
    const context = await icloud.connectionContext(current.username);
    const verification = await icloudProvider.verifyRuntimeSession(current.username, context);
    const config = await icloud.recordConnectionCheck(current.username, verification);
    return json(response, 200, {
      ...config,
      providerInfo: { id: verification.providerInfo.id, available: verification.providerInfo.available, version: verification.providerInfo.version },
      verification: { status: verification.status, message: verification.message },
    });
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/scan") {
    const context = await icloud.connectionContext(current.username);
    const scanResult = await icloudProvider.scanRecent({ ...context, jobKey: current.username, limit: 10 });
    if (scanResult.status !== "ready") {
      const config = await icloud.recordConnectionCheck(current.username, scanResult);
      return json(response, 200, { ...config, scan: await icloud.readScan(current.username), scanResult: { status: scanResult.status, message: scanResult.message } });
    }
    const config = await icloud.recordScan(current.username, scanResult);
    return json(response, 200, { ...config, scanResult: { status: scanResult.status, message: scanResult.message } });
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/timeline") {
    if (icloudBackupUsers.has(current.username) || icloudFullBackupJobs.has(current.username)) return json(response, 409, { error: "备份任务运行时不能刷新时间统计。" });
    const context = await icloud.connectionContext(current.username);
    const result = await icloudProvider.scanTimeline({ ...context, jobKey: current.username });
    if (result.status !== "ready") {
      if (result.status === "needs_auth") await icloud.recordConnectionCheck(current.username, result);
      return json(response, 200, { timeline: await icloud.readTimeline(current.username), timelineResult: { status: result.status, message: result.message } });
    }
    return json(response, 200, { timeline: await icloud.recordTimeline(current.username, result), timelineResult: { status: result.status, message: result.message } });
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/backup/test") {
    const previousBackup = await icloud.readBackup(current.username);
    if (previousBackup.completedAt) return json(response, 409, { error: "测试备份已经完成。为避免扩大下载范围，不能重复执行。" });
    if (icloudBackupUsers.has(current.username)) return json(response, 409, { error: "当前用户已有 iCloud 备份任务正在运行。" });
    icloudBackupUsers.add(current.username);
    try {
      const context = await icloud.connectionContext(current.username);
      const backupResult = await icloudProvider.backupRecent({ ...context, jobKey: current.username, limit: 3 });
      if (backupResult.status !== "completed") {
        if (backupResult.status === "needs_auth") await icloud.recordConnectionCheck(current.username, backupResult);
        return json(response, 200, { ...await icloud.read(current.username), backup: await icloud.readBackup(current.username), backupResult: { status: backupResult.status, message: backupResult.message, files: backupResult.files } });
      }
      const config = await icloud.recordBackup(current.username, backupResult);
      return json(response, 200, { ...config, backupResult: { status: backupResult.status, message: backupResult.message, files: backupResult.files } });
    } finally {
      icloudBackupUsers.delete(current.username);
    }
  }
  if (request.method === "POST" && (url.pathname === "/api/icloud/backup/full/start" || url.pathname === "/api/icloud/backup/full/resume")) {
    if (icloudBackupUsers.has(current.username) || icloudFullBackupJobs.has(current.username)) return json(response, 409, { error: "当前用户已有 iCloud 备份任务正在运行。" });
    const context = await icloud.connectionContext(current.username);
    const config = await icloud.read(current.username);
    if (config.connectionStatus !== "connected") return json(response, 409, { error: "请先验证 iCloud 登录会话。" });
    const previousManifest = await icloud.readFullManifest(current.username);
    const previousState = await icloud.readFullBackup(current.username);
    const body = await readJsonBody(request);
    const submittedRanges = Array.isArray(body.ranges) ? body.ranges.filter(item => item && typeof item.key === "string" && typeof item.label === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(item.start) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(item.end)).slice(0, 60) : [];
    const ranges = url.pathname.endsWith("/resume") && submittedRanges.length === 0 && ["paused", "failed"].includes(previousState.status) ? previousState.ranges : submittedRanges;
    const controller = new AbortController();
    const job = { controller, stopAs: "paused" };
    icloudFullBackupJobs.set(current.username, job);
    icloudBackupUsers.add(current.username);
    const startedAt = url.pathname.endsWith("/resume") && previousState.startedAt ? previousState.startedAt : new Date().toISOString();
    const initial = await icloud.writeFullBackup(current.username, {
      status: "planning", phase: "planning", message: previousManifest.files.length ? "正在检查增量变化并准备继续…" : "正在读取完整 iCloud 图库清单…",
      startedAt, completedAt: null, currentLibrary: null, currentRange: null, rangeIndex: 0, rangeCount: ranges.length || 1,
      completedRanges: [], planned: 0, downloaded: 0, verified: 0, skipped: 0, failed: 0, photoCount: 0, videoCount: 0, verifiedBytes: 0,
      ranges,
    });
    void (async () => {
      try {
        const result = await icloudProvider.backupAll({
          ...context, jobKey: current.username, previousFiles: previousManifest.files, ranges, signal: controller.signal,
          onProgress: update => icloud.writeFullBackup(current.username, update),
        });
        if (result.status === "aborted") {
          await icloud.writeFullBackup(current.username, { status: job.stopAs, phase: job.stopAs, message: job.stopAs === "cancelled" ? "完整备份已取消；已下载的本地文件会保留。" : result.message });
          return;
        }
        const savedManifest = result.files?.length ? await icloud.writeFullManifest(current.username, result.files) : previousManifest;
        const completed = result.status === "completed";
        await icloud.writeFullBackup(current.username, {
          status: completed ? "completed" : "failed", phase: completed ? "completed" : "failed", message: result.message,
          completedAt: completed ? new Date().toISOString() : null, currentLibrary: null, currentRange: null,
          rangeIndex: result.completedRanges?.length || 0, rangeCount: ranges.length || 1, completedRanges: result.completedRanges || [],
          planned: result.planned || 0, downloaded: result.planned || 0, verified: result.files?.length || 0,
          skipped: result.skipped || 0, failed: result.failed || 0, photoCount: result.photoCount || 0,
          videoCount: result.videoCount || 0, verifiedBytes: result.verifiedBytes || 0, manifestFileCount: savedManifest.files.length,
        });
        if (result.status === "needs_auth") await icloud.recordConnectionCheck(current.username, result);
      } catch {
        await icloud.writeFullBackup(current.username, { status: "failed", phase: "failed", message: "完整备份任务意外停止，可点击重试继续。" });
      } finally {
        icloudFullBackupJobs.delete(current.username);
        icloudBackupUsers.delete(current.username);
      }
    })();
    return json(response, 202, { fullBackup: initial });
  }
  if (request.method === "POST" && (url.pathname === "/api/icloud/backup/full/pause" || url.pathname === "/api/icloud/backup/full/cancel")) {
    const job = icloudFullBackupJobs.get(current.username);
    const stopAs = url.pathname.endsWith("/cancel") ? "cancelled" : "paused";
    if (!job) {
      const currentState = await icloud.readFullBackup(current.username);
      if (!["planning", "downloading", "verifying"].includes(currentState.status)) return json(response, 409, { error: "当前没有正在运行的完整备份任务。" });
      return json(response, 200, { fullBackup: await icloud.writeFullBackup(current.username, { status: stopAs, phase: stopAs, message: stopAs === "cancelled" ? "完整备份已取消。" : "完整备份已暂停，可稍后继续。" }) });
    }
    job.stopAs = stopAs;
    job.controller.abort();
    return json(response, 202, { fullBackup: await icloud.writeFullBackup(current.username, { message: stopAs === "cancelled" ? "正在安全取消…" : "正在安全暂停…" }) });
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/release/plan") {
    if (icloudBackupUsers.has(current.username) || icloudFullBackupJobs.has(current.username)) return json(response, 409, { error: "备份任务运行时不能生成释放计划。" });
    return json(response, 200, { releasePlan: await icloud.createReleasePlan(current.username) });
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/release/confirm") {
    const body = await readJsonBody(request);
    return json(response, 200, { releasePlan: await icloud.confirmReleasePlan(current.username, body.planId, body.confirmation) });
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/auth/start") {
    const context = await icloud.connectionContext(current.username);
    return json(response, 200, await icloudProvider.startAuthentication(current.username, context));
  }
  if (request.method === "GET" && url.pathname === "/api/icloud/auth/status") {
    const auth = icloudProvider.authenticationStatus(current.username);
    if (auth.status === "connected") {
      const config = await icloud.read(current.username);
      if (config.connectionStatus !== "connected") await icloud.recordConnectionCheck(current.username, { status: "connected", message: auth.message });
    }
    return json(response, 200, auth);
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/auth/input") {
    const body = await readJsonBody(request);
    return json(response, 200, icloudProvider.submitAuthenticationInput(current.username, body.type, body.value));
  }
  if (request.method === "POST" && url.pathname === "/api/icloud/auth/cancel") {
    return json(response, 200, icloudProvider.cancelAuthentication(current.username));
  }
  return json(response, 405, { error: "不支持的操作。" });
}

async function thumbnailAvailable(username, id) {
  try { return (await stat(join(userThumbnailDirectory(username), `${id}.webp`))).isFile(); } catch { return false; }
}

async function handleConfig(request, response, url) {
  const current = requirePc(request, response);
  if (!current) return;
  const username = current.username;
  const config = await readConfig(username);
  if (request.method === "GET") {
    const index = await buildIndex(username);
    const videoIndex = await Promise.all(index.videos.map(async video => ({
      id: video.id, sourceName: video.sourceName, path: video.path, size: video.size, modified: video.modified,
      thumbnailAvailable: await thumbnailAvailable(username, video.id),
    })));
    return json(response, 200, { folders: await folderDetails(config), accessUrls: accessUrls(), pairingCode: config.pairingCode, videoCount: index.videos.length, videoIndex });
  }
  if (request.method === "POST" && url.pathname === "/api/lan/config") {
    const body = await readJsonBody(request);
    if (typeof body.path !== "string" || !body.path.trim()) return json(response, 400, { error: "请输入文件夹的完整路径。" });
    const requestedPath = resolve(body.path.trim());
    let canonicalPath;
    try {
      canonicalPath = await realpath(requestedPath);
      if (!(await stat(canonicalPath)).isDirectory()) throw new Error();
    } catch { return json(response, 400, { error: "找不到这个文件夹，或当前服务没有读取权限。" }); }
    const existing = await Promise.all(config.videoFolders.map(async value => realpath(resolve(value)).catch(() => resolve(value))));
    if (!existing.some(value => value.toLocaleLowerCase() === canonicalPath.toLocaleLowerCase())) {
      config.videoFolders.push(canonicalPath);
      await saveConfig(username, config);
    }
    const index = await buildIndex(username, true);
    return json(response, 200, { ok: true, videoCount: index.videos.length });
  }
  if (request.method === "DELETE") {
    const index = Number(url.searchParams.get("index"));
    if (!Number.isInteger(index) || index < 0 || index >= config.videoFolders.length) return json(response, 400, { error: "共享目录不存在。" });
    config.videoFolders.splice(index, 1);
    await saveConfig(username, config);
    const updated = await buildIndex(username, true);
    return json(response, 200, { ok: true, videoCount: updated.videos.length });
  }
  if (request.method === "POST" && url.pathname === "/api/lan/rescan") {
    const index = await buildIndex(username, true);
    return json(response, 200, { ok: true, videoCount: index.videos.length });
  }
  if (request.method === "POST" && url.pathname === "/api/lan/pairing-code") {
    config.pairingCode = createPairingCode();
    config.accessToken = randomBytes(18).toString("base64url");
    await saveConfig(username, config);
    for (const [token, mobile] of mobileSessions) if (mobile.username === username) mobileSessions.delete(token);
    pairingAttempts.clear();
    return json(response, 200, { ok: true, pairingCode: config.pairingCode });
  }
  return json(response, 405, { error: "不支持的操作。" });
}

async function handlePairing(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "不支持的操作。" });
  const address = request.socket.remoteAddress || "unknown";
  const previous = pairingAttempts.get(address);
  const attempt = !previous || previous.resetAt <= Date.now() ? { count: 0, resetAt: Date.now() + 10 * 60_000 } : previous;
  if (attempt.count >= 8) return json(response, 429, { error: "验证码尝试次数过多，请十分钟后重试。" });
  const body = await readJsonBody(request);
  const code = String(body.code || "").trim();
  const sessions = accounts.activeSessions();
  let matched;
  for (const item of sessions) {
    const config = await readConfig(item.username);
    if (safeEqual(code, config.pairingCode)) { matched = item; break; }
  }
  if (!matched) {
    attempt.count += 1;
    pairingAttempts.set(address, attempt);
    return json(response, 401, { error: `验证码不正确，还可尝试 ${Math.max(0, 8 - attempt.count)} 次。` });
  }
  pairingAttempts.delete(address);
  const token = randomBytes(32).toString("hex");
  mobileSessions.set(token, { username: matched.username, pcToken: matched.token });
  return json(response, 200, { ok: true }, { "Set-Cookie": `framebase_lan_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800` });
}

async function handleVideoList(request, response) {
  const current = mobileSession(request);
  if (!current) return json(response, 401, { error: "请输入当前电脑端用户显示的六位验证码。", codeRequired: true });
  const index = await buildIndex(current.username);
  return json(response, 200, {
    videos: index.videos.map(video => ({ id: video.id, name: video.name, ext: video.ext, size: video.size, modified: video.modified, sourceName: video.sourceName, path: video.path, streamUrl: `/api/lan/videos/${video.id}/stream`, thumbnailUrl: `/api/lan/videos/${video.id}/thumbnail` })),
    sourceCount: index.signature ? index.signature.split("\n").length : 0,
  });
}

async function handleVideoStream(request, response, id) {
  const current = mobileSession(request);
  if (!current) return json(response, 401, { error: "设备尚未配对。" });
  const index = await buildIndex(current.username);
  const video = index.byId.get(id);
  if (!video) return json(response, 404, { error: "视频不存在或共享目录已经变更。" });
  let info;
  try { info = await stat(video.absolutePath); } catch { return json(response, 404, { error: "视频文件不可用。" }); }
  const range = request.headers.range;
  const commonHeaders = {
    "Accept-Ranges": "bytes", "Content-Type": mimeTypes[video.ext] || "application/octet-stream",
    "Cache-Control": "private, max-age=0", "X-Content-Type-Options": "nosniff",
  };
  if (!range) {
    response.writeHead(200, { ...commonHeaders, "Content-Length": info.size });
    if (request.method === "HEAD") return response.end();
    return createReadStream(video.absolutePath).pipe(response);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
    return response.end();
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2] || 0));
  const end = match[2] && match[1] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
    response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
    return response.end();
  }
  response.writeHead(206, { ...commonHeaders, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${info.size}` });
  if (request.method === "HEAD") return response.end();
  return createReadStream(video.absolutePath, { start, end }).pipe(response);
}

async function handleThumbnail(request, response, id) {
  const pc = isLocalAdmin(request) ? accounts.session(request) : null;
  const mobile = mobileSession(request);
  const current = request.method === "POST" ? pc : mobile;
  if (!current) return json(response, 401, { error: "请先登录或配对。" });
  const index = await buildIndex(current.username);
  if (!index.byId.has(id)) return json(response, 404, { error: "视频不存在。" });
  const directory = userThumbnailDirectory(current.username);
  const thumbnailPath = join(directory, `${id}.webp`);
  if (request.method === "POST") {
    if (!isLoopback(request.socket.remoteAddress)) return json(response, 403, { error: "缩略图只能从电脑端同步。" });
    if (request.headers.origin !== `http://${request.headers.host}`) return json(response, 403, { error: "请从 Framebase 页面发起操作。" });
    if (request.headers["content-type"] !== "image/webp") return json(response, 415, { error: "只接受 WebP 缩略图。" });
    const data = await readBinaryBody(request);
    if (!data.length) return json(response, 400, { error: "缩略图为空。" });
    await mkdir(directory, { recursive: true });
    await writeFile(thumbnailPath, data);
    return json(response, 200, { ok: true });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "不支持的操作。" });
  let info;
  try { info = await stat(thumbnailPath); } catch { return json(response, 404, { error: "缩略图尚未同步。" }); }
  response.writeHead(200, { "Content-Type": "image/webp", "Content-Length": info.size, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
  if (request.method === "HEAD") return response.end();
  return createReadStream(thumbnailPath).pipe(response);
}

function startingPage(response) {
  const body = Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1"><title>Framebase 正在启动</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f4f5ee;color:#20231f;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif}.card{text-align:center}.mark{width:48px;height:48px;display:grid;place-items:center;margin:0 auto 18px;border-radius:13px;background:#22251f;color:#d2f769;font-size:24px;font-weight:900}.spinner{width:160px;height:4px;overflow:hidden;margin:20px auto 0;border-radius:99px;background:#dfe2d7}.spinner:after{content:"";display:block;width:45%;height:100%;border-radius:inherit;background:#9abb43;animation:loading 1s ease-in-out infinite alternate}@keyframes loading{to{transform:translateX(125%)}}h1{margin:0;font-size:20px}p{margin:9px 0 0;color:#777d71;font-size:13px}</style></head><body><main class="card"><div class="mark">F</div><h1>Framebase 正在准备视频库</h1><p>页面就绪后会自动打开，请稍候。</p><div class="spinner"></div></main></body></html>`);
  response.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store", "Retry-After": "1" });
  response.end(body);
}

function proxyToApp(request, response, attempt = 0) {
  const canRetry = request.method === "GET" || request.method === "HEAD";
  const proxy = httpRequest({ hostname: appHost, port: appPort, method: request.method, path: request.url, headers: { ...request.headers, host: request.headers.host } }, upstream => {
    response.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.once("error", () => {
    if (canRetry && attempt < 80 && !response.headersSent && !response.destroyed) {
      setTimeout(() => proxyToApp(request, response, attempt + 1), 100);
      return;
    }
    if (!response.headersSent && !response.destroyed) {
      if (canRetry) startingPage(response);
      else json(response, 503, { error: "Framebase 页面正在启动，请稍后重试。" });
    }
  });
  if (canRetry) proxy.end();
  else request.pipe(proxy);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/account/")) return await handleAccount(request, response, url);
    if (url.pathname.startsWith("/api/icloud/")) return await handleIcloud(request, response, url);
    if (url.pathname === "/api/lan/power" || url.pathname.startsWith("/api/lan/power/")) return await handlePower(request, response, url);
    if (url.pathname === "/api/lan/config" || url.pathname === "/api/lan/rescan" || url.pathname === "/api/lan/pairing-code") return await handleConfig(request, response, url);
    if (url.pathname === "/api/lan/pick-folder") return await handleFolderPicker(request, response);
    if (url.pathname === "/api/lan/pair") return await handlePairing(request, response);
    if (url.pathname === "/api/lan/videos" && request.method === "GET") return await handleVideoList(request, response);
    const streamMatch = /^\/api\/lan\/videos\/([a-f0-9]{32})\/stream$/.exec(url.pathname);
    if (streamMatch && (request.method === "GET" || request.method === "HEAD")) return await handleVideoStream(request, response, streamMatch[1]);
    const thumbnailMatch = /^\/api\/lan\/videos\/([a-f0-9]{32})\/thumbnail$/.exec(url.pathname);
    if (thumbnailMatch) return await handleThumbnail(request, response, thumbnailMatch[1]);
    return proxyToApp(request, response);
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : "局域网服务发生错误。" });
  }
});

const vinextCommand = join(projectRoot, "node_modules", "vinext", "dist", "cli.js");
const appArguments = ["start", "--hostname", appHost, "--port", String(appPort)];
const appProcess = spawn(process.execPath, [vinextCommand, ...appArguments], { cwd: projectRoot, env: process.env, stdio: "inherit" });

server.listen(publicPort, "0.0.0.0", async () => {
  console.log(`\nFramebase: http://localhost:${publicPort}`);
  for (const url of accessUrls()) console.log(`移动端: ${url}`);
  console.log(`请在电脑端登录后打开共享设置: http://localhost:${publicPort}/lan\n`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const manager of powerManagers.values()) manager.stop();
  server.close();
  if (!appProcess.killed) appProcess.kill();
  setTimeout(() => process.exit(0), 1200).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
appProcess.on("exit", code => {
  if (shuttingDown) process.exit(0);
  if (code && code !== 0) console.error(`Framebase 页面服务退出，代码 ${code}`);
});
