import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIcloudPdProvider } from "../server/icloud-providers/icloudpd-provider.mjs";

test("Apple login reports rejected credentials without exposing private tool output", async t => {
  const root = await mkdtemp(join(tmpdir(), "framebase-login-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, "icloudpd.exe");
  await writeFile(executablePath, "test");
  let emitData;
  let emitExit;
  const provider = createIcloudPdProvider({
    executablePath,
    runCommand: async () => ({ stdout: "version:1.32.3" }),
    spawnProcess: () => ({
      onData: callback => { emitData = callback; },
      onExit: callback => { emitExit = callback; },
      write: () => {},
      kill: () => emitExit({ exitCode: 1 }),
    }),
  });
  const context = { appleAccount: "private@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: root };
  const cases = [
    ["Invalid email/password combination.", /Apple ID 或密码错误/],
    ["PyiCloudFailedLoginException: Invalid username/password combination.", /Apple ID 或密码错误/],
    ["Incorrect password", /Apple ID 或密码错误/],
    ["Your Apple ID or password is incorrect.", /Apple ID 或密码错误/],
    ["INVALID_CREDENTIALS\nFRAMEBASE_ERROR {\"status\":\"needs_auth\"}", /Apple ID 或密码错误/],
    ["Connection timed out", /无法连接/],
    ["PyiCloudFailedLoginException: Invalid verification code", /会话已经失效/],
    ["TypeError: invalid metadata", /工具执行异常/],
    ["None of providers gave password", /会话已经失效/],
  ];
  for (const [diagnostic, expected] of cases) {
    await provider.startAuthentication("alice", context);
    emitData("iCloud Password for private@example.com:");
    provider.submitAuthenticationInput("alice", "password", "private-secret");
    emitData(`private@example.com\n${diagnostic}`);
    emitExit({ exitCode: 1 });
    const result = provider.authenticationStatus("alice");
    assert.equal(result.status, "failed");
    assert.match(result.message, expected);
    assert.doesNotMatch(JSON.stringify(result), /private@example.com|private-secret/);
    assert.equal(provider.hasRuntimeCredential("alice"), false);
  }
});

test("authenticated timeline scan ignores MFA-like text in asset metadata but detects real split prompts", async t => {
  const root = await mkdtemp(join(tmpdir(), "framebase-scan-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, "icloudpd.exe");
  await writeFile(executablePath, "test");
  let loginData;
  let loginExit;
  let processCount = 0;
  let kills = 0;
  let needsMfa = false;
  const provider = createIcloudPdProvider({
    executablePath,
    runCommand: async () => ({ stdout: "version:1.32.3" }),
    spawnProcess: (_executable, args) => {
      const login = processCount++ === 0;
      let data;
      let exit;
      const child = {
        onData: callback => { data = callback; if (login) loginData = callback; },
        onExit: callback => { exit = callback; if (login) loginExit = callback; },
        write: () => {},
        kill: () => { kills++; exit({ exitCode: 1 }); },
      };
      if (!login) queueMicrotask(() => {
        if (args.includes("--list-libraries")) data("PrimarySync\r\n");
        else if (needsMfa) {
          data("Please enter two-factor authenti");
          data("cation code: ");
          return;
        } else {
          data('FRAMEBASE_INVENTORY_TOTAL {"count":1}\r\n');
          data('FRAMEBASE_INVENTORY {"id":"asset-2');
          data('FA-123","created":"2025-03-02T10:00:00+08:00","mediaType":"photo","originalBytes":100,"name":"verification code security code.jpg"}\r\n');
        }
        exit({ exitCode: 0 });
      });
      return child;
    },
  });
  const context = { jobKey: "alice", appleAccount: "private@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: root };
  await provider.startAuthentication("alice", context);
  loginData("iCloud Password for private@example.com:");
  provider.submitAuthenticationInput("alice", "password", "private-secret");
  loginExit({ exitCode: 0 });
  const result = await provider.scanTimeline(context);
  assert.equal(result.status, "ready");
  assert.equal(result.total.itemCount, 1);
  assert.equal(kills, 0);
  needsMfa = true;
  assert.equal((await provider.scanTimeline(context)).status, "needs_auth");
  assert.equal(kills, 1);
});
