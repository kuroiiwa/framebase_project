import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const shutdownArguments = ['/s', '/t', '0'];
export function shutdownWindows() {
  return new Promise((resolve, reject) => {
    // A Windows timeout greater than zero implies forced closing. Keep our cancellable
    // countdown in the service, then use zero timeout without /f.
    execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'shutdown.exe'), shutdownArguments,
      { windowsHide: true, timeout: 15000 }, error => error ? reject(new Error('Windows 未接受关机指令，请检查账户关机权限。')) : resolve());
  });
}

export function isLocalAdmin(request) {
  const address = request.socket.remoteAddress;
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  let host; try { host = new URL(`http://${request.headers.host}`).hostname; } catch { return false; }
  return local && ['localhost', '127.0.0.1', '[::1]'].includes(host);
}
export function isLanAddress(address = '') {
  const ip = address.replace(/^::ffff:/, '');
  return ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^(fc|fd)[a-f0-9]{2}:/i.test(ip) || /^fe80:/i.test(ip);
}
export function validatePowerRequest(request) {
  if (!isLanAddress(request.socket.remoteAddress)) fail(403, '远程关机仅限本机或局域网访问。');
  if (request.method === 'GET') return;
  if (request.method !== 'POST') fail(405, '不支持的操作。');
  if (request.headers['x-framebase-power'] !== '1' || request.headers['content-type']?.split(';')[0] !== 'application/json' || request.headers.origin !== `http://${request.headers.host}`) fail(403, '请从 Framebase 页面发起操作。');
}

export function createPowerManager({ path, readPairingToken, execute = shutdownWindows, platform = process.platform, now = Date.now, schedule = setTimeout, unschedule = clearTimeout }) {
  let state;
  let task = null;
  let timer;
  let chain = Promise.resolve();
  const usedRequests = new Set();
  const serial = operation => { const result = chain.then(operation); chain = result.catch(() => undefined); return result; };
  async function load() {
    if (state) return;
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (typeof parsed.enabled !== 'boolean' || !Array.isArray(parsed.devices)) throw new Error('关机设置无效');
      state = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { enabled: false, devices: [] };
    }
  }
  async function save() {
    try {
      await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    } catch (error) { state.enabled = false; cancel(); throw error; }
  }
  function cancel() {
    if (task?.phase === 'pending') { unschedule(timer); task = { ...task, phase: 'cancelled' }; }
  }
  async function epoch() { return hash(await readPairingToken()); }
  async function synchronize() {
    const current = await epoch();
    if (task?.phase === 'pending' && task.epoch !== current) cancel();
    return current;
  }
  function deviceFor(secret, current) { return state.devices.find(device => device.secretHash === hash(secret || '') && device.epoch === current); }
  async function status(secret, admin) {
    const current = await synchronize();
    const device = deviceFor(secret, current);
    return { enabled: state.enabled, supported: platform === 'win32', computerName: hostname(), serverNow: now(), countdownSeconds: 10,
      authorized: Boolean(device?.approved && state.enabled), device: device ? { id: device.id, name: device.name, approved: device.approved } : null,
      task: task ? { id: task.id, phase: task.phase, deadline: task.deadline, error: task.error } : null,
      ...(admin ? { devices: state.devices.filter(item => item.epoch === current).map(item => ({ id: item.id, name: item.name, approved: item.approved, created: item.created })) } : {}) };
  }
  const api = {
    status: (secret, admin = false) => serial(async () => { await load(); return status(secret, admin); }),
    action: (action, body, { secret = '', admin = false, paired = false } = {}) => serial(async () => {
      await load(); const current = await synchronize();
      if (platform !== 'win32') fail(501, '远程关机目前仅支持 Windows。');
      const device = deviceFor(secret, current);
      let cookie;
      if (action === 'settings') {
        if (!admin) fail(403, '只能在电脑端开启或关闭远程关机。');
        if (typeof body.enabled !== 'boolean') fail(400, '无效设置。');
        state.enabled = body.enabled; if (!state.enabled) cancel(); await save();
      } else if (action === 'register') {
        if (!paired || !state.enabled) fail(403, '请先配对，并在电脑端开启远程关机。');
        if (!device) {
          state.devices = state.devices.filter(item => item.epoch === current);
          if (state.devices.length >= 30) fail(409, '设备申请已达上限，请在电脑端移除不用的设备。');
          cookie = randomBytes(32).toString('hex');
          state.devices.push({ id: randomBytes(4).toString('hex').toUpperCase(), name: String(body.name || '我的手机').trim().slice(0, 40), secretHash: hash(cookie), epoch: current, approved: false, created: now() });
          await save();
        }
      } else if (action === 'approve' || action === 'remove') {
        if (!admin) fail(403, '只能在电脑端授权或移除设备。');
        const target = state.devices.find(item => item.id === body.deviceId && item.epoch === current);
        if (!target) fail(404, '设备申请不存在，请刷新。');
        if (action === 'approve') target.approved = true;
        else { state.devices = state.devices.filter(item => item !== target); if (task?.deviceId === target.id) cancel(); }
        await save();
      } else if (action === 'request') {
        if (!paired || !state.enabled || !device?.approved) fail(403, '这台设备尚未获得关机权限。');
        if (body.confirm !== true || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId || '')) fail(400, '请再次确认关机。');
        if (usedRequests.has(body.requestId)) return { data: await status(secret, admin) };
        if (task && ['pending', 'executing', 'accepted'].includes(task.phase)) fail(409, '已有一条关机指令，请勿重复提交。');
        usedRequests.add(body.requestId);
        if (usedRequests.size > 1000) usedRequests.delete(usedRequests.values().next().value);
        task = { id: body.requestId, deviceId: device.id, epoch: current, deadline: now() + 10000, phase: 'pending' };
        const scheduledId = task.id;
        timer = schedule(() => { void serial(async () => {
          await synchronize();
          if (task?.phase !== 'pending' || task.id !== scheduledId) return;
          if (!state.enabled || !state.devices.some(item => item.id === task.deviceId && item.approved && item.epoch === task.epoch)) { cancel(); return; }
          task.phase = 'executing';
          try { await execute(); task.phase = 'accepted'; }
          catch (error) { task.phase = 'failed'; task.error = error.message; }
        }).catch(error => { if (task) { task.phase = 'failed'; task.error = error.message; } }); }, 10000);
      } else if (action === 'cancel') {
        if (!admin && (!paired || !device?.approved)) fail(403, '无取消权限。');
        if (task?.phase === 'executing' || task?.phase === 'accepted') fail(409, '指令已交给 Windows，已无法从网页取消。');
        if (task?.phase === 'pending' && task.id !== body.taskId) fail(409, '关机任务已改变，请刷新后再取消。');
        cancel();
      } else fail(404, '未知操作。');
      return { data: await status(cookie || secret, admin), cookie };
    }),
    stop: () => { if (timer) unschedule(timer); cancel(); },
  };
  return api;
}
