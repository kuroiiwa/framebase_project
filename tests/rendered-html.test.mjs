import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the account gate before the desktop library", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Framebase · 本地视频管理<\/title>/);
  assert.match(html, /正在读取账户/);
  assert.doesNotMatch(html, /添加第一个视频文件夹/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("desktop insights remain wired to the library and player", async () => {
  const [page, insights, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/library-insights.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /目录健康检查/);
  assert.match(page, /随机抽卡/);
  assert.match(page, /buildStoryboard/);
  assert.match(page, /STORYBOARD_CACHE_MAX_ITEMS = 50/);
  assert.match(page, /STORYBOARD_CACHE_MAX_BYTES = 64 \* 1024 \* 1024/);
  assert.match(insights, /STORYBOARD_FRAME_COUNT = 24/);
  assert.match(insights, /STORYBOARD_WEBP_QUALITY = \.58/);
  assert.match(css, /\.storyboard-popover/);
  assert.match(css, /\.insight-tools/);
});
