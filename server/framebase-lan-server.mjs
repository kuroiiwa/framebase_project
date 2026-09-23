import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { createPowerManager, isLocalAdmin, validatePowerRequest } from "./framebase-power.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(projectRoot, ".framebase-lan.json");
const thumbnailDirectory = join(projectRoot, ".framebase-thumbnails");
const publicPort = Number(process.env.FRAMEBASE_LAN_PORT || 3000);
const appPort = Number(process.env.FRAMEBASE_APP_PORT || 3001);
const appHost = "127.0.0.1";
const videoExtensions = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "wmv", "flv", "mpeg", "mpg"]);
const mimeTypes = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mkv: "video/x-matroska", avi: "video/x-msvideo", wmv: "video/x-ms-wmv",
  flv: "video/x-flv", mpeg: "video/mpeg", mpg: "video/mpeg",
};

let indexCache = { signature: "", expires: 0, videos: [], byId: new Map() };
let indexingPromise = null;
const pairingAttempts = new Map();
const powerManager = createPowerManager({ path: join(projectRoot, ".framebase-power.json"), readPairingToken: async () => (await readConfig()).accessToken });

async function handlePower(request, response, url) {
  try {
    validatePowerRequest(request);
    const admin = isLocalAdmin(request);
    const paired = isPaired(request, await readConfig());
    if (!admin && !paired) return json(response, 401, { error: "请先输入配对验证码进入视频库。" });
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

async function readConfig() {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    const config = {
      accessToken: typeof parsed.accessToken === "string" && parsed.accessToken.length >= 16 ? parsed.accessToken : randomBytes(18).toString("base64url"),
      pairingCode: typeof parsed.pairingCode === "string" && /^\d{6}$/.test(parsed.pairingCode) ? parsed.pairingCode : createPairingCode(),
      videoFolders: Array.isArray(parsed.videoFolders) ? parsed.videoFolders.filter(value => typeof value === "string") : [],
    };
    if (config.accessToken !== parsed.accessToken || config.pairingCode !== parsed.pairingCode) await saveConfig(config);
    return config;
  } catch {
    const config = { accessToken: randomBytes(18).toString("base64url"), pairingCode: createPairingCode(), videoFolders: [] };
    await saveConfig(config);
    return config;
  }
}

async function saveConfig(config) {
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, configPath);
  indexCache.expires = 0;
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

function isPaired(request, config) {
  return safeEqual(cookieValue(request, "framebase_lan_session"), config.accessToken);
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

async function buildIndex(force = false) {
  if (!force && indexCache.expires > 0) {
    if (indexCache.expires <= Date.now() && !indexingPromise) {
      void buildIndex(true).catch(error => {
        indexCache.expires = Date.now() + 20_000;
        console.error("后台更新视频索引失败", error);
      });
    }
    return indexCache;
  }
  if (indexingPromise) return indexingPromise;
  indexingPromise = (async () => {
    const config = await readConfig();
    const roots = await configuredRoots(config);
    const signature = roots.map(root => root.path).join("\n");
    if (!force && indexCache.signature === signature && indexCache.expires > Date.now()) return indexCache;
    const videos = [];
    for (const root of roots) await walkVideos(root, root.path, videos);
    videos.sort((a, b) => b.modified - a.modified);
    indexCache = { signature, expires: Date.now() + 20_000, videos, byId: new Map(videos.map(video => [video.id, video])) };
    return indexCache;
  })();
  try { return await indexingPromise; } finally { indexingPromise = null; }
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
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$name = $env:FRAMEBASE_EXPECTED_SOURCE",
      "$dialog.Description = if ($name) { '请选择与缓存来源“' + $name + '”对应的文件夹' } else { '请选择要共享给手机浏览的文件夹' }",
      "$dialog.ShowNewFolderButton = $false",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "  [Console]::Out.Write($dialog.SelectedPath)",
      "}",
      "$dialog.Dispose()",
    ].join("\n");
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-Command", script], {
      encoding: "utf8",
      env: { ...process.env, FRAMEBASE_EXPECTED_SOURCE: expectedSource },
    }, (error, stdout) => {
      if (error) return rejectPromise(error);
      resolvePromise(stdout.trim() || null);
    });
  });
}

async function handleFolderPicker(request, response) {
  if (!isLoopback(request.socket.remoteAddress)) return json(response, 403, { error: "文件夹选择窗口只能从这台电脑打开。" });
  if (request.method !== "POST") return json(response, 405, { error: "不支持的操作。" });
  if (process.platform !== "win32") return json(response, 501, { error: "自动选择文件夹目前仅支持 Windows，请手动输入完整路径。" });
  const body = await readJsonBody(request);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 160) : "";
  const selectedPath = await pickWindowsFolder(name);
  return json(response, 200, selectedPath ? { path: selectedPath } : { cancelled: true });
}

async function thumbnailAvailable(id) {
  try { return (await stat(join(thumbnailDirectory, `${id}.webp`))).isFile(); } catch { return false; }
}

async function handleConfig(request, response, url) {
  if (!isLoopback(request.socket.remoteAddress)) return json(response, 403, { error: "共享设置只能在这台电脑上修改。" });
  const config = await readConfig();
  if (request.method === "GET") {
    const index = await buildIndex();
    const videoIndex = await Promise.all(index.videos.map(async video => ({
      id: video.id, sourceName: video.sourceName, path: video.path, size: video.size, modified: video.modified,
      thumbnailAvailable: await thumbnailAvailable(video.id),
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
      await saveConfig(config);
    }
    const index = await buildIndex(true);
    return json(response, 200, { ok: true, videoCount: index.videos.length });
  }
  if (request.method === "DELETE") {
    const index = Number(url.searchParams.get("index"));
    if (!Number.isInteger(index) || index < 0 || index >= config.videoFolders.length) return json(response, 400, { error: "共享目录不存在。" });
    config.videoFolders.splice(index, 1);
    await saveConfig(config);
    const updated = await buildIndex(true);
    return json(response, 200, { ok: true, videoCount: updated.videos.length });
  }
  if (request.method === "POST" && url.pathname === "/api/lan/rescan") {
    const index = await buildIndex(true);
    return json(response, 200, { ok: true, videoCount: index.videos.length });
  }
  if (request.method === "POST" && url.pathname === "/api/lan/pairing-code") {
    config.pairingCode = createPairingCode();
    config.accessToken = randomBytes(18).toString("base64url");
    await saveConfig(config);
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
  const config = await readConfig();
  if (typeof body.code !== "string" || !safeEqual(body.code.trim(), config.pairingCode)) {
    attempt.count += 1;
    pairingAttempts.set(address, attempt);
    return json(response, 401, { error: `验证码不正确，还可尝试 ${Math.max(0, 8 - attempt.count)} 次。` });
  }
  pairingAttempts.delete(address);
  return json(response, 200, { ok: true }, { "Set-Cookie": `framebase_lan_session=${encodeURIComponent(config.accessToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
}

async function handleVideoList(request, response) {
  const config = await readConfig();
  if (!isPaired(request, config)) return json(response, 401, { error: "请输入电脑端显示的六位验证码。", codeRequired: true });
  const index = await buildIndex();
  return json(response, 200, {
    videos: index.videos.map(video => ({ id: video.id, name: video.name, ext: video.ext, size: video.size, modified: video.modified, sourceName: video.sourceName, path: video.path, streamUrl: `/api/lan/videos/${video.id}/stream`, thumbnailUrl: `/api/lan/videos/${video.id}/thumbnail` })),
    sourceCount: indexCache.signature ? indexCache.signature.split("\n").length : 0,
  });
}

async function handleVideoStream(request, response, id) {
  const config = await readConfig();
  if (!isPaired(request, config)) return json(response, 401, { error: "设备尚未配对。" });
  const index = await buildIndex();
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
  const config = await readConfig();
  const index = await buildIndex();
  if (!index.byId.has(id)) return json(response, 404, { error: "视频不存在。" });
  const thumbnailPath = join(thumbnailDirectory, `${id}.webp`);
  if (request.method === "POST") {
    if (!isLoopback(request.socket.remoteAddress)) return json(response, 403, { error: "缩略图只能从电脑端同步。" });
    if (request.headers["content-type"] !== "image/webp") return json(response, 415, { error: "只接受 WebP 缩略图。" });
    const data = await readBinaryBody(request);
    if (!data.length) return json(response, 400, { error: "缩略图为空。" });
    await mkdir(thumbnailDirectory, { recursive: true });
    await writeFile(thumbnailPath, data);
    return json(response, 200, { ok: true });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "不支持的操作。" });
  if (!isPaired(request, config)) return json(response, 401, { error: "设备尚未配对。" });
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
  const config = await readConfig();
  console.log(`\nFramebase: http://localhost:${publicPort}`);
  for (const url of accessUrls()) console.log(`移动端: ${url}`);
  console.log(`配对验证码: ${config.pairingCode}`);
  console.log(`共享设置: http://localhost:${publicPort}/lan\n`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  powerManager.stop();
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
