import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const validId = /^[a-f0-9-]{36}$/;
export function redactDebug(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 4000).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[account]").replace(/(password|token|cookie|authorization|secret|verification.?code)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactDebug(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|token|cookie|authorization|secret|mfa/i.test(key) ? "[redacted]" : redactDebug(item, depth + 1)]));
  return value;
}

// Capture structured adapter diagnostics only. Raw PTY streams can echo credentials.
export function readIndexingDiagnostic(result = {}) {
  for (const match of `${result.stdout || ""}\n${result.stderr || ""}`.matchAll(/FRAMEBASE_INDEXING\s+(\{[^\r\n]+\})/g)) {
    try {
      const data = JSON.parse(match[1]);
      if (["FAILED", "RUNNING"].includes(data.indexingState) && data.readProbe === "readable" && Number.isInteger(data.count) && data.count > 0) return { indexingState: data.indexingState, zoneName: data.zoneName, readProbe: data.readProbe, count: data.count };
    } catch { /* Ignore malformed tool diagnostics. */ }
  }
  return null;
}

export function logToolDiagnostic(log, event, result = {}) {
  if (!log) return;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const records = [...output.matchAll(/FRAMEBASE_ERROR\s+(\{[^\r\n]+\})/g)].slice(-10).map(match => {
    try { const data = JSON.parse(match[1]); return { status: data.status, reason: data.reason, indexingState: data.indexingState, zoneName: data.zoneName, readProbeError: data.readProbeError }; } catch { return { malformed: true }; }
  });
  const exceptions = [...new Set([...output.matchAll(/(?:^|\n)\s*([A-Za-z_][A-Za-z_0-9]*(?:Error|Exception))(?=[:\s]|$)/g)].map(match => match[1]))].slice(0, 20);
  const frames = output.split(/\r?\n/).filter(line => /^\s*File "[^"]+", line \d+, in [A-Za-z_][\w.<>]*\s*$/.test(line)).slice(-20);
  log.write(event, { indexing: readIndexingDiagnostic(result), frames, code: result.code ?? result.exitCode ?? (result instanceof Error ? "unknown" : 0), signal: result.signal, killed: result.killed, errorType: result instanceof Error ? result.name : undefined, records, exceptions });
}

export function createDebugLogs({ projectRoot, runtime = {}, maxFiles = 30, maxBytes = 1024 * 1024 }) {
  function directory(username) {
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) throw new Error("Invalid log owner");
    return join(projectRoot, ".framebase-icloud", username, "logs");
  }
  function metadata(username, id) {
    return { id, path: join(directory(username), `${id}.log`), downloadUrl: `/api/icloud/debug/logs/${id}` };
  }
  function list(username, limit = maxFiles) {
    try { return readdirSync(directory(username)).filter(name => validId.test(name.replace(/\.log$/, "")) && name.endsWith(".log")).map(name => ({ ...metadata(username, name.slice(0, -4)), updatedAt: statSync(join(directory(username), name)).mtime.toISOString() })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit); }
    catch { return []; }
  }
  function start(username, operation, context = {}) {
    const info = metadata(username, randomUUID());
    let bytes = 0;
    let capped = false;
    const write = (event, data = {}) => {
      const final = event === "finished";
      if (capped && !final) return;
      try {
        mkdirSync(directory(username), { recursive: true });
        const line = JSON.stringify({ time: new Date().toISOString(), event, data: redactDebug(data) }) + "\n";
        // Reserve room for the final status even when a long scan fills the log.
        const limit = final ? maxBytes : maxBytes - Math.min(4096, Math.floor(maxBytes / 4));
        if (bytes + Buffer.byteLength(line) > limit) {
          if (!capped) { const marker = '{"event":"log_size_limit"}\n'; appendFileSync(info.path, marker); bytes += Buffer.byteLength(marker); }
          capped = true; return;
        }
        appendFileSync(info.path, line, { mode: 0o600 }); bytes += Buffer.byteLength(line);
      } catch { info.error = "诊断日志写入失败，请检查日志目录权限和磁盘空间。"; }
    };
    write("start", { operation, runtime: { ...runtime, node: process.version, platform: process.platform }, context });
    try { for (const old of list(username, Infinity).filter(old => old.id !== info.id).slice(maxFiles - 1)) if (old.id !== info.id) unlinkSync(old.path); } catch { /* Logging must not interrupt the operation. */ }
    return { info, write };
  }
  function read(username, id) {
    if (!validId.test(id)) return null;
    try { return readFileSync(metadata(username, id).path); } catch { return null; }
  }
  return { start, list, read };
}
