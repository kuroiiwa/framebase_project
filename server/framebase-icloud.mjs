import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const usernamePattern = /^[a-zA-Z0-9_]{3,32}$/;

function emptyConfig() {
  return {
    version: 1,
    selectedDirectory: null,
    backupDirectory: null,
    connectionStatus: "not_connected",
    appleAccount: null,
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

  async function read(username) {
    validateUsername(username);
    try {
      const parsed = JSON.parse(await readFile(configPath(username), "utf8"));
      return {
        ...emptyConfig(),
        selectedDirectory: typeof parsed.selectedDirectory === "string" ? parsed.selectedDirectory : null,
        backupDirectory: typeof parsed.backupDirectory === "string" ? parsed.backupDirectory : null,
        connectionStatus: parsed.connectionStatus === "connected" || parsed.connectionStatus === "expired" ? parsed.connectionStatus : "not_connected",
        appleAccount: typeof parsed.appleAccount === "string" ? parsed.appleAccount : null,
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

  return { read, configureBackupDirectory };
}
