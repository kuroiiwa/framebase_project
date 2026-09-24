import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
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

function spawnInteractive(executablePath, args) {
  return spawnPty(executablePath, args, {
    name: "xterm-color",
    cols: 120,
    rows: 30,
    env: process.env,
    useConpty: true,
  });
}

const runningAuthStates = new Set(["starting", "waiting_password", "verifying", "waiting_mfa"]);

function stripTerminalCodes(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27) {
      result += value[index];
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

export function createIcloudPdProvider({ executablePath, runCommand = runExecutable, spawnProcess = spawnInteractive }) {
  const authJobs = new Map();
  async function info() {
    try {
      if (!(await stat(executablePath)).isFile()) throw new Error("not-file");
      const { stdout, stderr } = await runCommand(executablePath, ["--version"], { timeout: 15_000 });
      const versionOutput = `${stdout || ""}\n${stderr || ""}`.trim().split(/\r?\n/).find(Boolean) || "icloudpd";
      const version = /version[:\s]+([^,\s]+)/i.exec(versionOutput)?.[1] || versionOutput;
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

  async function startAuthentication(jobKey, { appleAccount, domain, sessionDirectory, backupDirectory }) {
    const existing = authJobs.get(jobKey);
    if (existing && runningAuthStates.has(existing.status)) return publicAuthState(existing);
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
    };
    const close = code => {
      if (job.finished) return;
      job.finished = true;
      clearTimeout(job.timer);
      if (job.status === "cancelled") return;
      job.status = code === 0 ? "connected" : "failed";
      job.message = code === 0 ? "Apple iCloud 登录成功。" : safeMessage({ stderr: job.output }).message;
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
    clearTimeout(job.timer);
    job.child.kill();
    return publicAuthState(job);
  }

  return { id: "icloudpd", info, verifyExistingSession, startAuthentication, authenticationStatus, submitAuthenticationInput, cancelAuthentication };
}
