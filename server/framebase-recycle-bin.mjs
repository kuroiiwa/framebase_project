import { execFile } from "node:child_process";

function runExecutable(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: "utf8", windowsHide: true, timeout: 120_000, ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

const recycleScript = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:FRAMEBASE_RECYCLE_PATH, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
].join("; ");

export function createRecycleBin({ platform = process.platform, runCommand = runExecutable } = {}) {
  async function recycle(files) {
    if (Array.isArray(files) && files.length > 200) throw new Error("每次最多回收 200 个原文件（100 张实况照片）。");
    const requested = Array.isArray(files) ? files.filter(file => file && typeof file.path === "string" && typeof file.relativePath === "string" && Number(file.size) > 0) : [];
    if (!requested.length) return { status: "empty", message: "没有需要移入回收站的本地文件。", results: [], fileCount: 0, bytes: 0 };
    if (platform !== "win32") return { status: "unsupported", message: "当前系统暂不支持安全移入回收站。", results: requested.map(file => ({ ...file, status: "failed", reason: "unsupported" })), fileCount: 0, bytes: 0 };
    const results = [];
    for (const file of requested) {
      try {
        await runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", recycleScript], { env: { ...process.env, FRAMEBASE_RECYCLE_PATH: file.path } });
        results.push({ relativePath: file.relativePath, size: file.size, status: "recycled" });
      } catch {
        results.push({ relativePath: file.relativePath, size: file.size, status: "failed", reason: "recycle_failed" });
      }
    }
    const recycled = results.filter(result => result.status === "recycled");
    const bytes = recycled.reduce((sum, result) => sum + result.size, 0);
    return { status: recycled.length === requested.length ? "recycled" : recycled.length ? "partial" : "failed", message: recycled.length === requested.length ? `已将 ${recycled.length} 个本地文件移入 Windows 回收站。` : `本地回收完成 ${recycled.length}/${requested.length} 个文件；失败项目仍保留在原位置。`, results, fileCount: recycled.length, bytes };
  }

  return { recycle };
}
