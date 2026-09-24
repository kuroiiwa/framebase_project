import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIcloudPdProvider } from "../server/icloud-providers/icloudpd-provider.mjs";

test("icloudpd provider verifies an existing session without placing a password in process arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-"));
  const executablePath = join(root, "icloudpd.exe");
  const calls = [];
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (executable, args, options) => {
        calls.push({ executable, args, options });
        return args.includes("--version") ? { stdout: "icloudpd 1.32.3\n", stderr: "" } : { stdout: "", stderr: "" };
      },
    });
    const info = await provider.info();
    assert.equal(info.available, true);
    const result = await provider.verifyExistingSession({
      appleAccount: "alice@example.com",
      domain: "cn",
      sessionDirectory: join(root, "session"),
      backupDirectory: join(root, "backup"),
    });
    assert.equal(result.status, "connected");
    const verifyCall = calls.at(-1);
    assert.equal(verifyCall.executable, executablePath);
    assert.ok(verifyCall.args.includes("--auth-only"));
    assert.ok(verifyCall.args.includes("--cookie-directory"));
    assert.equal(verifyCall.args.includes("--password"), false);
    assert.equal(verifyCall.args.some(value => /secret|password123/i.test(value)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("icloudpd provider reports a missing authentication session without exposing tool output", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-auth-"));
  const executablePath = join(root, "icloudpd.exe");
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => {
        if (args.includes("--version")) return { stdout: "icloudpd 1.32.3\n", stderr: "" };
        throw Object.assign(new Error("failed"), { stderr: "None of providers gave password for alice@example.com" });
      },
    });
    const result = await provider.verifyExistingSession({ appleAccount: "alice@example.com", domain: "com", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup") });
    assert.equal(result.status, "needs_auth");
    assert.equal(result.message.includes("alice@example.com"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("icloudpd provider passes password and MFA only through the temporary pseudo-terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-login-"));
  const executablePath = join(root, "icloudpd.exe");
  const writes = [];
  let spawnedArgs;
  let child;
  let emitData;
  let emitExit;
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => args.includes("--version") ? { stdout: "version:1.32.3\n", stderr: "" } : { stdout: "", stderr: "" },
      spawnProcess: (_executable, args) => {
        spawnedArgs = args;
        child = {
          onData: callback => { emitData = callback; },
          onExit: callback => { emitExit = callback; },
          write: value => { writes.push(value); },
          kill: () => emitExit({ exitCode: 1 }),
        };
        return child;
      },
    });
    await provider.startAuthentication("gabri", { appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup") });
    emitData("iCloud Password for alice@example.com:");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(provider.authenticationStatus("gabri").status, "waiting_password");
    provider.submitAuthenticationInput("gabri", "password", "secret-value");
    assert.deepEqual(writes, ["secret-value\r"]);
    assert.equal(spawnedArgs.includes("secret-value"), false);
    assert.equal(spawnedArgs.includes("--password"), false);
    emitData("Two-factor authentication is required (2fa)\nEnter the code:");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(provider.authenticationStatus("gabri").status, "waiting_mfa");
    provider.submitAuthenticationInput("gabri", "mfa", "123456");
    assert.deepEqual(writes, ["secret-value\r", "123456\r"]);
    emitExit({ exitCode: 0 });
    assert.equal(provider.authenticationStatus("gabri").status, "connected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
