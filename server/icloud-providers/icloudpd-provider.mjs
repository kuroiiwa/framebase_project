import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn as spawnPty } from "node-pty";

function runExecutable(executablePath, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(executablePath, args, { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

function safeMessage(error) {
  const combined = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
  if (/none of providers gave password|password|two-factor|2fa|authentication|authenticate/i.test(combined)) {
    return { status: "needs_auth", message: "尚未登录，或 Apple 验证会话已经失效。" };
  }
  if (/timed out|network|connection|connect|service unavailable|name resolution/i.test(combined)) {
    return { status: "network_error", message: "暂时无法连接 Apple iCloud 服务。" };
  }
  return { status: "error", message: "无法验证 iCloud 会话，请稍后重试。" };
}

function spawnInteractive(executablePath, args, options = {}) {
  return spawnPty(executablePath, args, {
    name: "xterm-color",
    cols: 120,
    rows: 30,
    env: { ...process.env, ...(options.env || {}) },
    useConpty: true,
  });
}

const runningAuthStates = new Set(["starting", "waiting_password", "verifying", "waiting_mfa"]);
const photoExtensions = new Set(["jpg", "jpeg", "heic", "heif", "png", "gif", "tif", "tiff", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"]);
const videoExtensions = new Set(["mov", "mp4", "m4v", "avi", "mkv", "mpeg", "mpg", "webm"]);
const destructiveFlags = new Set(["--auto-delete", "--delete-after-download", "--keep-icloud-recent-days"]);

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function stripTerminalCodes(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27) {
      result += value[index];
      continue;
    }
    if (value[index + 1] === "]") {
      index += 2;
      while (index < value.length && value.charCodeAt(index) !== 7) {
        if (value.charCodeAt(index) === 27 && value[index + 1] === "\\") { index += 1; break; }
        index += 1;
      }
      continue;
    }
    if (value[index + 1] !== "[") continue;
    index += 2;
    while (index < value.length && !/[A-Za-z]/.test(value[index])) index += 1;
  }
  return result;
}

function publicAuthState(job) {
  if (!job) return { status: "idle", message: "尚未开始登录。" };
  return { status: job.status, message: job.message, startedAt: job.startedAt };
}

export function createIcloudPdProvider({ executablePath, runCommand = runExecutable, spawnProcess = spawnInteractive, hashFile = sha256File, verificationConcurrency = 2, progressInterval = 1000 }) {
  const authJobs = new Map();
  const sessionSecrets = new Map();
  const safeVerificationConcurrency = Math.min(4, Math.max(1, Math.floor(Number(verificationConcurrency) || 2)));
  const safeProgressInterval = Math.max(10, Math.floor(Number(progressInterval) || 1000));

  function runWithRuntimePassword(args, password, timeout = 120_000, signal, processOptions = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawnProcess(executablePath, args, processOptions); }
      catch (error) { reject(error); return; }
      let output = "";
      let settled = false;
      let passwordSent = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(Object.assign(new Error("backup aborted"), { name: "AbortError" }));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(Object.assign(new Error("timed out"), { stderr: output }));
      }, timeout);
      timer.unref?.();
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      const observe = chunk => {
        output = stripTerminalCodes(`${output}${String(chunk)}`).slice(-64_000);
        if (!passwordSent && /icloud password|password for/i.test(output)) {
          passwordSent = true;
          if (typeof child.write === "function") child.write(`${password}\r`);
          else child.stdin.write(`${password}\n`);
        }
        if (/two-factor authentication|2fa|verification code|security code|enter the code/i.test(output) && !settled) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          reject(Object.assign(new Error("two-factor authentication required"), { stderr: output }));
        }
      };
      if (typeof child.onData === "function") child.onData(observe);
      else {
        child.stdout?.on("data", observe);
        child.stderr?.on("data", observe);
      }
      const close = code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (code === 0) resolve({ stdout: output, stderr: "" });
        else reject(Object.assign(new Error(`icloudpd exited with code ${code}`), { stderr: output }));
      };
      if (typeof child.onExit === "function") child.onExit(event => close(event.exitCode));
      else {
        child.once("error", error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        });
        child.once("close", close);
      }
    });
  }
  async function info() {
    try {
      if (!(await stat(executablePath)).isFile()) throw new Error("not-file");
      const { stdout, stderr } = await runCommand(executablePath, ["--version"], { timeout: 15_000 });
      const versionOutput = `${stdout || ""}\n${stderr || ""}`.trim().split(/\r?\n/).find(Boolean) || "icloudpd";
      const parsedVersion = /version[:\s]+([^,\s]+)/i.exec(versionOutput)?.[1] || versionOutput;
      const version = basename(executablePath).includes("framebase-compatible")
        ? "1.32.3 · FrameBase 兼容版"
        : parsedVersion;
      return { id: "icloudpd", available: true, version, executablePath };
    } catch {
      return { id: "icloudpd", available: false, version: null, executablePath };
    }
  }

  async function verifyExistingSession({ appleAccount, domain, sessionDirectory, backupDirectory }) {
    const providerInfo = await info();
    if (!providerInfo.available) return { status: "tool_missing", message: "找不到 icloudpd 可执行文件。", providerInfo };
    await mkdir(sessionDirectory, { recursive: true });
    const args = [
      "--log-level", "error",
      "--no-progress-bar",
      "--domain", domain,
      "--password-provider", "parameter",
      "--mfa-provider", "console",
      "--auth-only",
      "--cookie-directory", sessionDirectory,
      "--directory", backupDirectory,
      "--username", appleAccount,
    ];
    try {
      await runCommand(executablePath, args, { timeout: 45_000 });
      return { status: "connected", message: "Apple iCloud 会话有效。", providerInfo };
    } catch (error) {
      return { ...safeMessage(error), providerInfo };
    }
  }

  async function verifyRuntimeSession(jobKey, context) {
    const password = sessionSecrets.get(jobKey);
    if (!password) return verifyExistingSession(context);
    const providerInfo = await info();
    if (!providerInfo.available) return { status: "tool_missing", message: "找不到 icloudpd 可执行文件。", providerInfo };
    const args = [
      "--log-level", "error",
      "--no-progress-bar",
      "--domain", context.domain,
      "--password-provider", "console",
      "--mfa-provider", "console",
      "--auth-only",
      "--cookie-directory", context.sessionDirectory,
      "--directory", context.backupDirectory,
      "--username", context.appleAccount,
    ];
    try {
      await runWithRuntimePassword(args, password, 45_000);
      return { status: "connected", message: "Apple iCloud 会话有效。", providerInfo };
    } catch (error) {
      return { ...safeMessage(error), providerInfo };
    }
  }

  async function scanRecent({ jobKey, appleAccount, domain, sessionDirectory, backupDirectory, limit = 10 }) {
    const providerInfo = await info();
    if (!providerInfo.available) return { status: "tool_missing", message: "找不到 icloudpd 可执行文件。", providerInfo };
    const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
    const password = sessionSecrets.get(jobKey);
    const baseArgs = [
      "--log-level", "error",
      "--no-progress-bar",
      "--domain", domain,
      "--password-provider", password ? "console" : "parameter",
      "--mfa-provider", "console",
      "--cookie-directory", sessionDirectory,
      "--directory", backupDirectory,
      "--username", appleAccount,
    ];
    try {
      const cleanOutput = value => String(value || "").replace(/i?cloud password for [^:\r\n]+:/gi, "");
      const parseSamples = value => cleanOutput(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const name = basename(line);
        const extension = extname(name).slice(1).toLowerCase();
        const mediaType = videoExtensions.has(extension) ? "video" : photoExtensions.has(extension) ? "photo" : null;
        return { name, extension, mediaType };
      }).filter(item => item.mediaType);
      const runReadOnly = args => password
        ? runWithRuntimePassword(args, password)
        : runCommand(executablePath, args, { timeout: 120_000 });
      const scanLibrary = async library => {
        const libraryArgs = library ? ["--library", library] : [];
        const { stdout } = await runReadOnly([...baseArgs, ...libraryArgs, "--recent", String(safeLimit), "--only-print-filenames"]);
        return parseSamples(stdout);
      };
      let samples = await scanLibrary(null);
      let librariesChecked = 1;
      if (samples.length === 0) {
        const { stdout } = await runReadOnly([...baseArgs, "--list-libraries"]);
        const libraries = [...new Set(cleanOutput(stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean))].slice(0, 8);
        for (const library of libraries) {
          samples = [...samples, ...await scanLibrary(library)];
          librariesChecked += 1;
          if (samples.length >= safeLimit) break;
        }
      }
      samples = samples.slice(0, safeLimit);
      return { status: "ready", message: `已只读检查 ${librariesChecked} 个图库，找到最近 ${samples.length} 个媒体项目。`, samples, requestedLimit: safeLimit, providerInfo };
    } catch (error) {
      return { ...safeMessage(error), samples: [], requestedLimit: safeLimit, providerInfo };
    }
  }

  async function backupRecent({ jobKey, appleAccount, domain, sessionDirectory, backupDirectory, limit = 3 }) {
    const providerInfo = await info();
    if (!providerInfo.available) return { status: "tool_missing", message: "找不到 icloudpd 可执行文件。", files: [], providerInfo };
    const safeLimit = Math.max(1, Math.min(3, Number(limit) || 3));
    const password = sessionSecrets.get(jobKey);
    const baseArgs = [
      "--log-level", "error",
      "--no-progress-bar",
      "--domain", domain,
      "--password-provider", password ? "console" : "parameter",
      "--mfa-provider", "console",
      "--cookie-directory", sessionDirectory,
      "--directory", backupDirectory,
      "--username", appleAccount,
    ];
    const runReadOnly = args => password
      ? runWithRuntimePassword(args, password, 180_000)
      : runCommand(executablePath, args, { timeout: 180_000 });
    const cleanLines = value => String(value || "").replace(/i?cloud password for [^:\r\n]+:/gi, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const plannedPaths = value => cleanLines(value).map(line => {
      const extension = extname(line).slice(1).toLowerCase();
      if (!photoExtensions.has(extension) && !videoExtensions.has(extension)) return null;
      const absolutePath = isAbsolute(line) ? resolve(line) : resolve(backupDirectory, line);
      const pathWithinBackup = relative(resolve(backupDirectory), absolutePath);
      if (pathWithinBackup.startsWith("..") || isAbsolute(pathWithinBackup)) return null;
      return { absolutePath, relativePath: pathWithinBackup.split("\\").join("/"), extension };
    }).filter(Boolean).slice(0, safeLimit);
    try {
      await mkdir(backupDirectory, { recursive: true });
      let library = null;
      let libraryArgs = [];
      let { stdout } = await runReadOnly([...baseArgs, "--recent", String(safeLimit), "--only-print-filenames"]);
      let plan = plannedPaths(stdout);
      if (plan.length === 0) {
        const librariesResult = await runReadOnly([...baseArgs, "--list-libraries"]);
        const libraries = [...new Set(cleanLines(librariesResult.stdout))].slice(0, 8);
        for (const candidate of libraries) {
          const candidateArgs = ["--library", candidate];
          ({ stdout } = await runReadOnly([...baseArgs, ...candidateArgs, "--recent", String(safeLimit), "--only-print-filenames"]));
          plan = plannedPaths(stdout);
          if (plan.length > 0) { library = candidate; libraryArgs = candidateArgs; break; }
        }
      }
      if (plan.length === 0) return { status: "empty", message: "没有找到可用于测试备份的媒体项目。", files: [], providerInfo };
      const downloadArgs = [
        ...baseArgs,
        ...libraryArgs,
        "--recent", String(safeLimit),
        "--size", "original",
        "--live-photo-size", "original",
      ];
      if (downloadArgs.some(argument => destructiveFlags.has(argument))) throw new Error("unsafe backup arguments");
      await runReadOnly(downloadArgs);
      const files = [];
      for (const item of plan) {
        try {
          const info = await stat(item.absolutePath);
          if (!info.isFile() || info.size <= 0) continue;
          files.push({
            name: basename(item.absolutePath),
            relativePath: item.relativePath,
            extension: item.extension,
            mediaType: videoExtensions.has(item.extension) ? "video" : "photo",
            size: info.size,
            sha256: await hashFile(item.absolutePath),
          });
        } catch { /* A missing or empty file fails local verification and is not reported as safe. */ }
      }
      if (files.length !== plan.length) {
        return { status: "verification_failed", message: `已下载，但只有 ${files.length}/${plan.length} 个项目通过本地非空验证。`, files, library, providerInfo };
      }
      return { status: "completed", message: `已安全备份并验证 ${files.length} 个项目；iCloud 原文件未删除。`, files, library, providerInfo };
    } catch (error) {
      return { ...safeMessage(error), files: [], providerInfo };
    }
  }

  async function backupAll({ jobKey, appleAccount, domain, sessionDirectory, backupDirectory, previousFiles = [], ranges = [], initialCompletedRanges = [], signal, onProgress = () => undefined, onRangeComplete = () => undefined }) {
    const providerInfo = await info();
    if (!providerInfo.available) return { status: "tool_missing", message: "找不到 icloudpd 可执行文件。", files: [], providerInfo };
    const password = sessionSecrets.get(jobKey);
    const baseArgs = [
      "--log-level", "error",
      "--no-progress-bar",
      "--domain", domain,
      "--password-provider", password ? "console" : "parameter",
      "--mfa-provider", "console",
      "--cookie-directory", sessionDirectory,
      "--directory", backupDirectory,
      "--username", appleAccount,
    ];
    const mediaArgs = [
      ...baseArgs,
      "--size", "original",
      "--live-photo-size", "original",
    ];
    const run = (args, timeout, maxBuffer = 64 * 1024 * 1024) => password
      ? runWithRuntimePassword(args, password, timeout, signal)
      : runCommand(executablePath, args, { timeout, maxBuffer, signal });
    const cleanLines = value => String(value || "").replace(/i?cloud password for [^:\r\n]+:/gi, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const parsePaths = (value, library) => cleanLines(value).map(line => {
      const extension = extname(line).slice(1).toLowerCase();
      if (!photoExtensions.has(extension) && !videoExtensions.has(extension)) return null;
      const absolutePath = isAbsolute(line) ? resolve(line) : resolve(backupDirectory, line);
      const pathWithinBackup = relative(resolve(backupDirectory), absolutePath);
      if (!pathWithinBackup || pathWithinBackup.startsWith("..") || isAbsolute(pathWithinBackup)) return null;
      return { absolutePath, relativePath: pathWithinBackup.split("\\").join("/"), extension, library };
    }).filter(Boolean);
    const previousByPath = new Map(previousFiles.map(item => [item.relativePath, item]));
    const safeRanges = Array.isArray(ranges) ? ranges.filter(item => item && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(item.start) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(item.end)).slice(0, 60) : [];
    const requestedRanges = safeRanges.length ? safeRanges : [{ key: "all", label: "全部时间", start: null, end: null }];
    const rangeArgs = range => range.start ? ["--skip-created-before", range.start, "--skip-created-after", range.end] : [];
    const listLocalMedia = async (directory, plannedByPath) => {
      const files = [];
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error?.code === "ENOENT") return files; throw error; }
      for (const entry of entries) {
        if (signal?.aborted) throw Object.assign(new Error("backup aborted"), { name: "AbortError" });
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await listLocalMedia(absolutePath, plannedByPath));
        else if (entry.isFile()) {
          const extension = extname(entry.name).slice(1).toLowerCase();
          if (photoExtensions.has(extension) || videoExtensions.has(extension)) {
            const relativePath = relative(resolve(backupDirectory), absolutePath).split("\\").join("/");
            files.push({ absolutePath, relativePath, extension, library: plannedByPath.get(relativePath)?.library || null });
          }
        }
      }
      return files;
    };
    const verificationDirectories = range => {
      if (!range.start) return [backupDirectory];
      const start = new Date(`${range.start}Z`);
      const end = new Date(`${range.end}Z`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
      const directories = [];
      const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
      while (cursor <= last && directories.length < 720) {
        directories.push(join(backupDirectory, String(cursor.getUTCFullYear()), String(cursor.getUTCMonth() + 1).padStart(2, "0")));
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
      return directories;
    };
    try {
      await mkdir(backupDirectory, { recursive: true });
      const completedRanges = [...new Set((Array.isArray(initialCompletedRanges) ? initialCompletedRanges : []).filter(key => requestedRanges.some(range => range.key === key)))];
      await onProgress({ status: "planning", phase: "planning", rangeIndex: 0, rangeCount: requestedRanges.length, completedRanges: [...completedRanges], message: "正在读取 iCloud 图库清单…" });
      const libraryResult = await run([...baseArgs, "--list-libraries"], 180_000);
      const namedLibraries = [...new Set(cleanLines(libraryResult.stdout))].slice(0, 32);
      const libraries = [null, ...namedLibraries];
      const planByPath = new Map();
      const filesByPath = new Map();
      const downloadedSizes = new Map();
      const transferSamples = [{ at: Date.now(), bytes: 0 }];
      let transferredBytes = 0;
      let lastTransferAt = 0;
      let plannedPhotoCount = 0;
      let plannedVideoCount = 0;
      let skipped = 0;
      let failed = 0;
      let verifiedBytes = 0;
      const inspectPlannedItems = async items => {
        const found = [];
        let cursor = 0;
        const workers = Array.from({ length: Math.min(8, items.length) }, async () => {
          while (cursor < items.length) {
            const item = items[cursor++];
            try {
              const fileInfo = await stat(item.absolutePath);
              if (fileInfo.isFile() && fileInfo.size > 0) found.push({ item, size: fileInfo.size });
            } catch (error) { if (error?.code !== "ENOENT") throw error; }
          }
        });
        await Promise.all(workers);
        return found;
      };
      const downloadMetrics = () => {
        let downloadedBytes = 0; let syncedPhotoCount = 0; let syncedVideoCount = 0;
        for (const [relativePath, size] of downloadedSizes) {
          downloadedBytes += size;
          const extension = planByPath.get(relativePath)?.extension || extname(relativePath).slice(1).toLowerCase();
          if (videoExtensions.has(extension)) syncedVideoCount += 1; else syncedPhotoCount += 1;
        }
        const latest = transferSamples.at(-1);
        const earliest = transferSamples[0];
        const elapsedSeconds = latest && earliest ? Math.max(0.001, (latest.at - earliest.at) / 1000) : 0;
        const transferRateBps = Date.now() - lastTransferAt > safeProgressInterval * 4 || !elapsedSeconds ? 0 : Math.max(0, Math.round((latest.bytes - earliest.bytes) / elapsedSeconds));
        return { plannedPhotoCount, plannedVideoCount, downloaded: syncedPhotoCount + syncedVideoCount, syncedPhotoCount, syncedVideoCount, downloadedBytes, transferRateBps };
      };
      const refreshDownloadMetrics = async (items, countTransfer = true) => {
        const found = await inspectPlannedItems(items);
        let addedBytes = 0;
        for (const { item, size } of found) {
          const previousSize = downloadedSizes.get(item.relativePath) || 0;
          if (countTransfer && size > previousSize) addedBytes += size - previousSize;
          downloadedSizes.set(item.relativePath, size);
        }
        const now = Date.now();
        if (addedBytes > 0) { transferredBytes += addedBytes; lastTransferAt = now; }
        transferSamples.push({ at: now, bytes: transferredBytes });
        while (transferSamples.length > 2 && transferSamples[0].at < now - 8000) transferSamples.shift();
        return downloadMetrics();
      };
      for (let rangeOffset = 0; rangeOffset < requestedRanges.length; rangeOffset += 1) {
        const range = requestedRanges[rangeOffset];
        const rangeIndex = rangeOffset + 1;
        const currentRange = range.label || range.key;
        const rangePlan = new Map();
        const activeOperations = [];
        await onProgress({ status: "planning", phase: "planning", currentRange, rangeIndex, rangeCount: requestedRanges.length, completedRanges, planned: planByPath.size, verified: filesByPath.size, skipped, failed, verifiedBytes, message: `正在规划 ${rangeIndex}/${requestedRanges.length}：${currentRange}…` });
        for (const library of libraries) {
          if (signal?.aborted) throw Object.assign(new Error("backup aborted"), { name: "AbortError" });
          const libraryArgs = library ? ["--library", library] : [];
          const result = await run([...mediaArgs, ...libraryArgs, ...rangeArgs(range), "--only-print-filenames"], 30 * 60_000);
          const items = parsePaths(result.stdout, library);
          if (items.length > 0) activeOperations.push({ library, range, items });
          for (const item of items) {
            if (!rangePlan.has(item.relativePath)) rangePlan.set(item.relativePath, item);
            if (!planByPath.has(item.relativePath)) {
              planByPath.set(item.relativePath, item);
              if (videoExtensions.has(item.extension)) plannedVideoCount += 1; else plannedPhotoCount += 1;
            }
          }
          await onProgress({ status: "planning", phase: "planning", currentLibrary: library || "主图库", currentRange, rangeIndex, rangeCount: requestedRanges.length, completedRanges, planned: planByPath.size, verified: filesByPath.size, skipped, failed, verifiedBytes, ...downloadMetrics(), message: `${currentRange} 已规划 ${rangePlan.size} 个媒体文件。` });
        }
        let completedLibraries = 0;
        for (const operation of activeOperations) {
          const { library, items } = operation;
          if (signal?.aborted) throw Object.assign(new Error("backup aborted"), { name: "AbortError" });
          const libraryArgs = library ? ["--library", library] : [];
          const downloadArgs = [...mediaArgs, ...libraryArgs, ...rangeArgs(range)];
          if (downloadArgs.some(argument => destructiveFlags.has(argument))) throw new Error("unsafe backup arguments");
          await refreshDownloadMetrics(items, false);
          await onProgress({ status: "downloading", phase: "downloading", currentLibrary: library || "主图库", currentRange, rangeIndex, rangeCount: requestedRanges.length, completedRanges, planned: planByPath.size, verified: filesByPath.size, skipped, failed, verifiedBytes, ...downloadMetrics(), message: `正在备份 ${rangeIndex}/${requestedRanges.length}：${currentRange} · ${library ? `图库“${library}”` : "主图库"}…` });
          let polling = false;
          let progressPoll = Promise.resolve();
          const progressTimer = setInterval(() => {
            if (polling) return;
            polling = true;
            progressPoll = refreshDownloadMetrics(items).then(metrics => onProgress({ status: "downloading", phase: "downloading", currentLibrary: library || "主图库", currentRange, rangeIndex, rangeCount: requestedRanges.length, completedRanges, planned: planByPath.size, verified: filesByPath.size, skipped, failed, verifiedBytes, ...metrics, message: `正在同步 ${metrics.syncedPhotoCount}/${metrics.plannedPhotoCount} 张图片、${metrics.syncedVideoCount}/${metrics.plannedVideoCount} 个视频…` })).catch(() => undefined).finally(() => { polling = false; });
          }, safeProgressInterval);
          progressTimer.unref?.();
          try { await run(downloadArgs, 24 * 60 * 60_000, 8 * 1024 * 1024); }
          finally { clearInterval(progressTimer); await progressPoll; }
          completedLibraries += 1;
          const metrics = await refreshDownloadMetrics(items);
          await onProgress({ status: "downloading", phase: "downloading", currentLibrary: library || "主图库", currentRange, rangeIndex, rangeCount: requestedRanges.length, completedRanges, planned: planByPath.size, verified: filesByPath.size, skipped, failed, verifiedBytes, ...metrics, transferRateBps: 0, message: `${currentRange} 下载进度 ${completedLibraries}/${activeOperations.length} 个图库。` });
        }
        const rangeVerificationByPath = new Map();
        for (const directory of verificationDirectories(range)) {
          for (const item of await listLocalMedia(directory, rangePlan)) rangeVerificationByPath.set(item.relativePath, item);
        }
        for (const item of rangeVerificationByPath.values()) if (!planByPath.has(item.relativePath)) planByPath.set(item.relativePath, item);
        const verificationPlan = [...rangeVerificationByPath.values()];
        const failedBeforeRange = failed;
        for (let batchStart = 0; batchStart < verificationPlan.length; batchStart += safeVerificationConcurrency) {
          if (signal?.aborted) throw Object.assign(new Error("backup aborted"), { name: "AbortError" });
          const batch = verificationPlan.slice(batchStart, batchStart + safeVerificationConcurrency);
          const results = await Promise.all(batch.map(async item => {
            try {
              const fileInfo = await stat(item.absolutePath);
              if (!fileInfo.isFile() || fileInfo.size <= 0) throw new Error("empty file");
              if (signal?.aborted) throw Object.assign(new Error("backup aborted"), { name: "AbortError" });
              return { item, fileInfo, sha256: await hashFile(item.absolutePath) };
            } catch (error) {
              if (error?.name === "AbortError") throw error;
              return { item, error };
            }
          }));
          for (const result of results) {
            if (result.error) { failed += 1; continue; }
            const { item, fileInfo, sha256 } = result;
            const previous = previousByPath.get(item.relativePath);
            if (previous?.size === fileInfo.size && previous?.sha256 === sha256) skipped += 1;
            const existing = filesByPath.get(item.relativePath);
            if (existing) verifiedBytes -= existing.size;
            const verifiedFile = {
              name: basename(item.absolutePath), relativePath: item.relativePath, extension: item.extension,
              mediaType: videoExtensions.has(item.extension) ? "video" : "photo", size: fileInfo.size,
              sha256, library: item.library, verifiedAt: new Date().toISOString(),
            };
            filesByPath.set(item.relativePath, verifiedFile);
            verifiedBytes += fileInfo.size;
          }
          const processed = batchStart + batch.length;
          if (processed % 10 === 0 || processed === verificationPlan.length) {
            await onProgress({ status: "verifying", phase: "verifying", currentLibrary: null, currentRange, rangeIndex, rangeCount: requestedRanges.length, completedRanges, planned: planByPath.size, verified: filesByPath.size, skipped, failed, verifiedBytes, ...downloadMetrics(), transferRateBps: 0, message: `正在使用 ${safeVerificationConcurrency} 路并行校验 ${rangeIndex}/${requestedRanges.length}：${currentRange}（${processed}/${verificationPlan.length}）…` });
          }
        }
        const rangeVerified = verificationPlan.length > 0 && failed === failedBeforeRange;
        if (rangeVerified) {
          if (!completedRanges.includes(range.key)) completedRanges.push(range.key);
          const rangeFiles = verificationPlan.map(item => filesByPath.get(item.relativePath)).filter(Boolean);
          await onRangeComplete({ range, files: rangeFiles, completedRanges: [...completedRanges] });
        } else {
          const completedIndex = completedRanges.indexOf(range.key);
          if (completedIndex >= 0) completedRanges.splice(completedIndex, 1);
        }
        await onProgress({ status: rangeIndex === requestedRanges.length ? "verifying" : "planning", phase: rangeIndex === requestedRanges.length ? "verifying" : "planning", currentLibrary: null, currentRange, rangeIndex, rangeCount: requestedRanges.length, completedRanges: [...completedRanges], planned: planByPath.size, verified: filesByPath.size, skipped, failed, verifiedBytes, ...downloadMetrics(), transferRateBps: 0, message: rangeVerified ? `${currentRange} 已完成规划、下载和校验${rangeIndex < requestedRanges.length ? "，即将处理下一个时间范围。" : "。"}` : `${currentRange} 有文件未通过完整性校验，保留为未完成状态。` });
      }
      const files = [...filesByPath.values()];
      const verificationTotal = files.length + failed;
      if (verificationTotal === 0) return { status: "empty", message: "所选时间范围内没有找到可备份的图片或视频。", files: [], planned: planByPath.size, completedRanges, providerInfo };
      const photoCount = files.filter(item => item.mediaType === "photo").length;
      const videoCount = files.length - photoCount;
      if (failed > 0) return { status: "verification_failed", message: `${files.length}/${verificationTotal} 个文件通过 SHA-256 完整性校验，${failed} 个需要重试。`, files, planned: planByPath.size, plannedPhotoCount, plannedVideoCount, downloadedBytes: downloadMetrics().downloadedBytes, skipped, failed, photoCount, videoCount, verifiedBytes, completedRanges, providerInfo };
      return { status: "completed", message: `已依次完成 ${completedRanges.length} 个时间范围，验证 ${files.length} 个文件（图片 ${photoCount}、视频 ${videoCount}）；iCloud 原文件未删除。`, files, planned: planByPath.size, plannedPhotoCount, plannedVideoCount, downloadedBytes: downloadMetrics().downloadedBytes, skipped, failed: 0, photoCount, videoCount, verifiedBytes, completedRanges, providerInfo };
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) return { status: "aborted", message: "备份任务已安全停止，可稍后从本地已有文件继续。", files: [], providerInfo };
      return { ...safeMessage(error), files: [], providerInfo };
    }
  }

  async function scanTimeline({ jobKey, appleAccount, domain, sessionDirectory, backupDirectory }) {
    const providerInfo = await info();
    if (!providerInfo.available) return { status: "tool_missing", message: "找不到 icloudpd 可执行文件。", providerInfo, years: [], quarters: [], months: [] };
    const password = sessionSecrets.get(jobKey);
    const baseArgs = [
      "--log-level", "error", "--no-progress-bar", "--domain", domain,
      "--password-provider", password ? "console" : "parameter", "--mfa-provider", "console",
      "--cookie-directory", sessionDirectory, "--directory", backupDirectory, "--username", appleAccount,
      "--size", "original", "--live-photo-size", "original", "--align-raw", "original", "--only-print-filenames",
    ];
    const inventoryEnv = { ...process.env, FRAMEBASE_INVENTORY_JSON: "1" };
    const runInventory = args => password
      ? runWithRuntimePassword(args, password, 60 * 60_000, undefined, { env: inventoryEnv })
      : runCommand(executablePath, args, { timeout: 60 * 60_000, maxBuffer: 128 * 1024 * 1024, env: inventoryEnv });
    const empty = key => ({ key, photoCount: 0, videoCount: 0, livePhotoCount: 0, rawCount: 0, originalBytes: 0, itemCount: 0 });
    const increment = (map, key, item) => {
      const bucket = map.get(key) || empty(key);
      bucket.itemCount += 1;
      bucket.originalBytes += Math.max(0, Number(item.originalBytes) || 0);
      if (item.mediaType === "video") bucket.videoCount += 1; else bucket.photoCount += 1;
      if (item.livePhoto) bucket.livePhotoCount += 1;
      if (item.raw) bucket.rawCount += 1;
      map.set(key, bucket);
    };
    try {
      const libraryArgs = baseArgs.filter(argument => argument !== "--only-print-filenames");
      const librariesResult = password
        ? await runWithRuntimePassword([...libraryArgs, "--list-libraries"], password, 180_000)
        : await runCommand(executablePath, [...libraryArgs, "--list-libraries"], { timeout: 180_000, maxBuffer: 1024 * 1024 });
      const libraries = [...new Set(String(librariesResult.stdout || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
      const targets = libraries.length ? libraries.slice(0, 32) : [null];
      const itemsById = new Map();
      for (const library of targets) {
        const result = await runInventory([...baseArgs, ...(library ? ["--library", library] : [])]);
        for (const line of String(result.stdout || "").split(/\r?\n/)) {
          if (!line.startsWith("FRAMEBASE_INVENTORY ")) continue;
          try {
            const item = JSON.parse(line.slice("FRAMEBASE_INVENTORY ".length));
            if (item?.id && item?.created) itemsById.set(`${library || "default"}:${item.id}`, item);
          } catch { /* Ignore malformed provider output without exposing it. */ }
        }
      }
      const years = new Map(); const quarters = new Map(); const months = new Map();
      for (const item of itemsById.values()) {
        const created = new Date(item.created);
        if (Number.isNaN(created.getTime())) continue;
        const year = created.getFullYear();
        if (year < 1900 || year > 2200) continue;
        const month = created.getMonth() + 1;
        increment(years, String(year), item);
        increment(quarters, `${year}-Q${Math.floor((month - 1) / 3) + 1}`, item);
        increment(months, `${year}-${String(month).padStart(2, "0")}`, item);
      }
      const newestFirst = map => [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
      const totals = new Map();
      for (const item of itemsById.values()) increment(totals, "total", item);
      const total = totals.get("total") || empty("total");
      return { status: "ready", message: `已只读统计 ${total.itemCount} 个 iCloud 媒体项目。`, scannedAt: new Date().toISOString(), total, years: newestFirst(years), quarters: newestFirst(quarters), months: newestFirst(months), providerInfo };
    } catch (error) {
      return { ...safeMessage(error), years: [], quarters: [], months: [], providerInfo };
    }
  }

  async function startAuthentication(jobKey, { appleAccount, domain, sessionDirectory, backupDirectory }) {
    const existing = authJobs.get(jobKey);
    if (existing && runningAuthStates.has(existing.status)) return publicAuthState(existing);
    sessionSecrets.delete(jobKey);
    const providerInfo = await info();
    if (!providerInfo.available) return { status: "tool_missing", message: "找不到 icloudpd 可执行文件。" };
    await mkdir(sessionDirectory, { recursive: true });
    const args = [
      "--log-level", "error",
      "--no-progress-bar",
      "--domain", domain,
      "--password-provider", "console",
      "--mfa-provider", "console",
      "--auth-only",
      "--cookie-directory", sessionDirectory,
      "--directory", backupDirectory,
      "--username", appleAccount,
    ];
    const child = spawnProcess(executablePath, args);
    const job = { child, status: "starting", message: "正在启动 Apple 登录…", startedAt: new Date().toISOString(), output: "", timer: null, finished: false };
    authJobs.set(jobKey, job);

    const observe = chunk => {
      job.output = stripTerminalCodes(`${job.output}${String(chunk)}`).slice(-12_000);
      if (/icloud password|password for/i.test(job.output)) {
        job.status = "waiting_password";
        job.message = "请输入 Apple ID 密码。密码只会传给本机 icloudpd 进程。";
      } else if (/two-factor authentication|2fa|verification code|security code|enter the code/i.test(job.output)) {
        job.status = "waiting_mfa";
        job.message = "请输入 Apple 设备上显示的六位验证码。";
      }
    };
    if (typeof child.onData === "function") child.onData(observe);
    else {
      child.stdout?.on("data", observe);
      child.stderr?.on("data", observe);
    }
    const failToStart = () => {
      if (job.finished) return;
      job.finished = true;
      clearTimeout(job.timer);
      job.status = "failed";
      job.message = "无法启动 icloudpd 登录进程。";
      job.output = "";
      job.password = "";
      sessionSecrets.delete(jobKey);
    };
    const close = code => {
      if (job.finished) return;
      job.finished = true;
      clearTimeout(job.timer);
      if (job.status === "cancelled") return;
      job.status = code === 0 ? "connected" : "failed";
      job.message = code === 0 ? "Apple iCloud 登录成功。" : safeMessage({ stderr: job.output }).message;
      if (code === 0 && job.password) sessionSecrets.set(jobKey, job.password);
      else sessionSecrets.delete(jobKey);
      job.password = "";
      job.output = "";
    };
    if (typeof child.onExit === "function") child.onExit(event => close(event.exitCode));
    else {
      child.once("error", failToStart);
      child.once("close", close);
    }
    job.timer = setTimeout(() => {
      if (!runningAuthStates.has(job.status) || job.finished) return;
      job.finished = true;
      job.status = "failed";
      job.message = "Apple 登录等待超时，请重新开始。";
      job.output = "";
      job.password = "";
      sessionSecrets.delete(jobKey);
      child.kill();
    }, 10 * 60 * 1000);
    job.timer.unref?.();
    return publicAuthState(job);
  }

  function authenticationStatus(jobKey) {
    return publicAuthState(authJobs.get(jobKey));
  }

  function submitAuthenticationInput(jobKey, type, value) {
    const job = authJobs.get(jobKey);
    if (!job || !runningAuthStates.has(job.status)) throw Object.assign(new Error("当前没有等待输入的 Apple 登录任务。"), { status: 409 });
    if (type === "password") {
      if (job.status !== "waiting_password") throw Object.assign(new Error("当前登录步骤不需要密码。"), { status: 409 });
      if (typeof value !== "string" || value.length < 1 || value.length > 1024) throw Object.assign(new Error("请输入 Apple ID 密码。"), { status: 400 });
      job.password = value;
    } else if (type === "mfa") {
      if (job.status !== "waiting_mfa") throw Object.assign(new Error("当前登录步骤不需要验证码。"), { status: 409 });
      if (!/^\d{6}$/.test(String(value || "").trim())) throw Object.assign(new Error("请输入六位 Apple 验证码。"), { status: 400 });
    } else throw Object.assign(new Error("不支持的登录输入类型。"), { status: 400 });
    if (typeof job.child.write === "function") job.child.write(`${value}\r`);
    else job.child.stdin.write(`${value}\n`);
    job.status = "verifying";
    job.message = type === "password" ? "正在验证 Apple ID 密码…" : "正在验证双重验证码…";
    job.output = "";
    return publicAuthState(job);
  }

  function cancelAuthentication(jobKey) {
    const job = authJobs.get(jobKey);
    if (!job || !runningAuthStates.has(job.status)) return publicAuthState(job);
    job.status = "cancelled";
    job.finished = true;
    job.message = "登录已取消。";
    job.output = "";
    job.password = "";
    sessionSecrets.delete(jobKey);
    clearTimeout(job.timer);
    job.child.kill();
    return publicAuthState(job);
  }

  return { id: "icloudpd", info, verifyExistingSession, verifyRuntimeSession, scanRecent, scanTimeline, backupRecent, backupAll, startAuthentication, authenticationStatus, submitAuthenticationInput, cancelAuthentication, hasRuntimeCredential: jobKey => sessionSecrets.has(jobKey) };
}
