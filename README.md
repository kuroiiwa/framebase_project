# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## 视频库操作

- **选择**：点击“选择”后可全选本页、全选全部筛选结果、反选本页或取消全部。按住 Shift 点击卡片或勾选按钮可按当前排序跨页连选；页面会提示不在本页及不符合筛选的已选数量，也可单独取消隐藏项。
- **快捷键**：电脑和手机浏览器的播放器统一支持空格播放/暂停、左右快进/快退 10 秒、上下调节音量 5%、M 静音、F 全屏、Esc 退出全屏或返回。输入框内不触发播放快捷键。全屏等能力取决于浏览器支持。
- **扫描任务**：显示目录扫描数量及预览生成进度，支持暂停、继续、取消、重试失败预览和生成未完成预览。暂停和取消在当前文件处理结束后生效；取消未完成的目录扫描不会替换原清单，已完成的预览保留。扫描全部来源时取消当前任务也会停止后续来源。
- **播放队列**：电脑端播放器显示打开视频时的全部筛选结果，支持队列搜索、点击切换、顺序播放、随机打乱和单条循环。自动连播可单独开启，队列末尾停止；切回顺序播放会恢复原顺序。

## 局域网访问设置

双击 `启动 Framebase.cmd` 后，电脑端仍使用 `http://localhost:3000`。在电脑端点击顶部的“局域网”，或直接打开 `http://localhost:3000/lan`：

1. 点击电脑端已缓存的来源名称，在弹出的 Windows 文件夹选择窗口中确认对应目录；系统会自动添加并记住完整路径。
2. 也可以点击“浏览…”选择其他目录，或手动输入完整路径，例如 `D:\视频素材`。
3. 添加后复制页面生成的固定移动端地址。
4. 让手机连接同一个 Wi-Fi 或局域网，在手机浏览器打开该地址，并输入电脑端显示的六位验证码。
5. 保持电脑上的 Framebase 启动窗口打开。验证成功后手机会保持配对，除非电脑端生成了新验证码。

移动端只提供视频清单、缩略图和视频流，并支持搜索、筛选、排序与随机打乱。手机端不能添加或移除共享目录，也没有删除、标记或文件管理接口。共享设置保存在项目目录下的 `.framebase-lan.json`，缩略图会从电脑端现有预览缓存同步到 `.framebase-thumbnails`；两者均已被 Git 忽略。

如果手机无法连接，请在 Windows 防火墙弹窗中允许 Node.js 在“专用网络”通信。不要在公共 Wi-Fi 上启用此服务。

## 手机远程关机（Windows）

1. 重启 `启动 Framebase.cmd`，电脑浏览器打开 `http://localhost:3000/lan`，在“远程关机设置”勾选“允许手机远程关机”（默认关闭）。
2. 手机连接同一局域网，完成视频库配对后，在页面底部填写设备名称，点击“申请关机权限”。
3. 电脑端核对手机显示的八位设备编号，点击“核对并授权”。仅凭视频库配对不能关机。
4. 手机点击“关闭电脑…”，确认目标电脑后点击“确认，10 秒后关机”。手机和电脑设置页均显示倒计时，并可点击“取消关机”。

倒计时由本地服务执行，手机关闭网页不会取消任务。关闭远程关机开关、移除发起设备、更新视频配对凭据或停止服务，会取消尚未提交的任务。服务重启不会恢复旧任务。Windows 接受指令后网页不能再取消；连接中断不代表已成功关机。未保存的程序可能阻止关机，系统不会被强制关闭程序。

独立设备权限保存在被 Git 忽略的 `.framebase-power.json`；浏览器使用独立 HttpOnly 设备凭据。授权管理仅允许电脑通过 localhost 访问；关机接口仅接受同源、局域网请求。当前不提供外网关机或远程开机。

验证：`node --test tests/power.test.mjs` 使用模拟时钟和模拟系统执行器，不会执行真实关机。

## 参考资料

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
