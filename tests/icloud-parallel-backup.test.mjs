import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIcloudPdProvider } from "../server/icloud-providers/icloudpd-provider.mjs";

test("full backups enable bounded downloads only for a tool advertising support", async t => {
  const root = await mkdtemp(join(tmpdir(), "framebase-parallel-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, "icloudpd.exe");
  const backupDirectory = join(root, "backup");
  await writeFile(executablePath, "test");
  await mkdir(backupDirectory);
  for (const [capable, requested, expected] of [[true, undefined, "2"], [true, 4, "4"], [true, 100, "8"], [true, Infinity, "2"], [false, 4, null]]) {
    const calls = [];
    const provider = createIcloudPdProvider({
      executablePath,
      downloadConcurrency: requested,
      runCommand: async (_executable, args) => {
        calls.push(args);
        if (args.includes("--version")) return { stdout: `version:1.32.3${capable ? " · FrameBase inventory recovery + parallel downloads" : ""}` };
        if (args.includes("--list-libraries")) return { stdout: "" };
        if (args.includes("--only-print-filenames")) return { stdout: "image.jpg\n" };
        await writeFile(join(backupDirectory, "image.jpg"), "photo");
        return { stdout: "" };
      },
    });
    const result = await provider.backupAll({ jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory });
    assert.equal(result.status, "completed");
    const download = calls.at(-1);
    assert.equal(download.includes("--threads-num"), capable);
    if (capable) assert.equal(download[download.indexOf("--threads-num") + 1], expected);
    assert.ok(calls.filter(args => args.includes("--list-libraries") || args.includes("--only-print-filenames")).every(args => !args.includes("--threads-num")));
    assert.ok(calls.every(args => !args.some(arg => ["--auto-delete", "--delete-after-download", "--keep-icloud-recent-days"].includes(arg))));
  }
});
