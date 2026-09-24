import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAccounts } from "../server/framebase-accounts.mjs";

test("account setup, registration and admin summaries stay scoped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framebase-accounts-"));
  try {
    const path = join(directory, "accounts.json");
    const accounts = createAccounts(path);
    await assert.rejects(accounts.register("gabri"), { status: 403 });
    const adminToken = await accounts.register("admin", "admin-password", true);
    const gabriToken = await accounts.register("gabri");
    await assert.rejects(accounts.register("gabri"), { status: 409 });
    await assert.rejects(accounts.login("admin", "wrong-password", "local"), { status: 401 });
    assert.ok(await accounts.login("admin", "admin-password", "local"));
    assert.ok(await accounts.login("gabri", undefined, "local"));
    const gabriRequest = { headers: { cookie: accounts.cookie(gabriToken) } };
    assert.equal(accounts.session(gabriRequest)?.username, "gabri");
    await accounts.updateSummary("gabri", [{ name: "素材", videoCount: 2, totalSize: 300 }]);
    const data = await accounts.read();
    assert.equal(data.users.find(user => user.username === "gabri").videoCount, 2);
    assert.equal(data.users.find(user => user.username === "admin").videoCount, 0);
    assert.equal(Object.hasOwn(data.users.find(user => user.username === "gabri"), "passwordHash"), false);
    assert.doesNotMatch(await readFile(path, "utf8"), /admin-password/);
    assert.ok(accounts.hasSession(adminToken));
    accounts.logout(gabriRequest);
    assert.equal(accounts.session(gabriRequest), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
