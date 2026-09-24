import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const usernamePattern = /^[a-zA-Z0-9_]{3,32}$/;
const sessions = new Map();
const attempts = new Map();

export function createAccounts(path) {
  let writing = Promise.resolve();
  let updates = Promise.resolve();
  function mutate(operation) {
    const result = updates.then(operation);
    updates = result.catch(() => undefined);
    return result;
  }
  async function read() {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { users: [] }; throw error; }
  }
  async function save(data) {
    const task = writing.then(async () => {
      await writeFile(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    writing = task.catch(() => undefined);
    return task;
  }
  function safeCompare(left, right) {
    const a = Buffer.from(left || ""); const b = Buffer.from(right || "");
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async function passwordHash(password, salt = randomBytes(16).toString("hex")) {
    return `${salt}:${(await scrypt(password, salt, 64)).toString("hex")}`;
  }
  async function verify(password, stored) {
    const salt = stored.split(":")[0];
    return safeCompare(await passwordHash(password, salt), stored);
  }
  function validate(username, password, setupAdmin) {
    if (!usernamePattern.test(username) || username.toLowerCase() === "admin" && username !== "admin") throw Object.assign(new Error("用户名需为 3–32 位字母、数字或下划线。"), { status: 400 });
    if (setupAdmin && (typeof password !== "string" || password.length < 8 || password.length > 128)) throw Object.assign(new Error("管理员密码需为 8–128 位。"), { status: 400 });
  }
  function session(request) {
    const value = String(request.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith("framebase_account="))?.slice(18) || "";
    const item = sessions.get(value);
    if (!item || item.expires < Date.now()) { sessions.delete(value); return null; }
    return { ...item, token: value };
  }
  function createSession(username) {
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { username, expires: Date.now() + 7 * 86400_000 });
    return token;
  }
  function cookie(token) { return `framebase_account=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`; }
  async function register(username, password, setupAdmin = false) {
    validate(username, password, setupAdmin);
    return mutate(async () => {
      const data = await read();
      if (setupAdmin && (username !== "admin" || data.users.length)) throw Object.assign(new Error("管理员已经设置。"), { status: 409 });
      if (!setupAdmin && !data.users.some(user => user.username === "admin")) throw Object.assign(new Error("请先设置管理员账户。"), { status: 403 });
      if (!setupAdmin && username.toLowerCase() === "admin") throw Object.assign(new Error("admin 已保留，请使用管理员登录。"), { status: 403 });
      if (data.users.some(user => user.username.toLowerCase() === username.toLowerCase())) throw Object.assign(new Error("用户名已存在。"), { status: 409 });
      data.users.push({ username, ...(setupAdmin ? { passwordHash: await passwordHash(password) } : {}), sources: [], videoCount: 0, totalSize: 0 });
      await save(data);
      return createSession(username);
    });
  }
  async function login(username, password, address) {
    const data = await read();
    const user = data.users.find(item => item.username.toLowerCase() === username.toLowerCase());
    if (!user) throw Object.assign(new Error("用户不存在，请先注册。"), { status: 401 });
    if (user.username === "admin") {
      const key = `${address}:admin`;
      const attempt = attempts.get(key);
      if (attempt?.until > Date.now() && attempt.count >= 8) throw Object.assign(new Error("尝试次数过多，请十分钟后重试。"), { status: 429 });
      const valid = typeof password === "string" && user.passwordHash && await verify(password, user.passwordHash);
      if (!valid) {
        attempts.set(key, { count: (attempt?.until > Date.now() ? attempt.count : 0) + 1, until: Date.now() + 600_000 });
        throw Object.assign(new Error("管理员密码不正确。"), { status: 401 });
      }
      attempts.delete(key);
    }
    return createSession(user.username);
  }
  async function updateSummary(username, sources) {
    return mutate(async () => {
      const data = await read();
      const user = data.users.find(item => item.username === username);
      if (!user) return;
      const nonnegative = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
      user.sources = sources.map(item => ({ name: String(item?.name || "").slice(0, 160), videoCount: Math.floor(nonnegative(item?.videoCount)), totalSize: Math.floor(nonnegative(item?.totalSize)) }));
      user.videoCount = user.sources.reduce((sum, item) => sum + item.videoCount, 0);
      user.totalSize = user.sources.reduce((sum, item) => sum + item.totalSize, 0);
      await save(data);
    });
  }
  function logout(request) { const current = session(request); if (current) sessions.delete(current.token); return current; }
  return { read, register, login, session, cookie, logout, updateSummary, activeSessions: () => [...sessions].map(([token, value]) => ({ token, ...value })).filter(item => item.expires > Date.now()), hasSession: token => (sessions.get(token)?.expires || 0) > Date.now() };
}
