# FrameBase 的 icloudpd 兼容说明

本文记录 FrameBase 在 Windows 上接入 `icloudpd` 时遇到的 Apple Photos 区域发现问题，以及如何在全新工作副本中重建当前兼容版本。`tools/` 整体被 `.gitignore` 排除，因此可执行文件、源码副本和 Python 虚拟环境都不会随 Git 提交；维护者必须保留本文档。

## 当前结论

- FrameBase 仍通过可替换 Provider 调用 `icloudpd`，没有把第三方源码耦合进业务代码。
- 官方 Windows 版 `icloudpd 1.32.3` 对部分 Apple Photos 账户会出现：认证成功、iCloud 网页能看到照片，但 CLI 图库或媒体列表为空。
- 对应上游修复是 [PR #1367：Discover migrated Apple Photos primary zones](https://github.com/icloud-photos-downloader/icloud_photos_downloader/pull/1367)。截至本次集成时，该修复尚未包含在官方 `1.32.3` Windows 可执行文件中。
- FrameBase 本机兼容程序的约定路径是 `tools/icloudpd/icloudpd-framebase-compatible.exe`。如果该文件存在，FrameBase 优先使用它；否则回退到 `tools/icloudpd/icloudpd-1.32.3-windows-amd64.exe`。
- 环境变量 `FRAMEBASE_ICLOUDPD_PATH` 的优先级最高，可用于显式选择其他 Provider 可执行文件。

## 根因

`icloudpd 1.32.3` 初始化主照片图库时硬编码区域名：

```python
zone_id = {"zoneName": "PrimarySync"}
```

Apple 会把部分账户的主区域迁移到 `PrimarySync1` 或其他以 `PrimarySync` 开头的名称。旧实现仍可完成 Apple ID 和双重认证，但查询了错误区域，因此表现为“0 个媒体项目”。

PR #1367 修改了两处：

1. `src/pyicloud_ipd/services/photos.py`
   - 初始化照片服务前调用私有图库的 `/zones/list`。
   - 从未删除的区域中选择第一个 `zoneName.startswith("PrimarySync")` 的区域。
   - 缓存私有区域结果，避免重复查询。
   - 找不到主区域时明确抛出 `PyiCloudServiceNotActivatedException`。
2. `src/icloudpd/base.py`
   - 用户传入历史名称 `--library PrimarySync` 时，如果实际主区域是 `PrimarySync*`，仍映射到主照片图库。

不要只修改 FrameBase 的输出解析逻辑；问题发生在 `icloudpd` 查询 Apple Photos 区域之前。

## 从零重建 Windows 兼容程序

以下操作在 `tools/icloudpd/` 下进行。该目录不受 Git 跟踪。

1. 获取与官方 `1.32.3` 对应的源码，并放到例如：

   ```text
   tools/icloudpd/source-review/icloud_photos_downloader-master
   ```

2. 获取并应用上游精确补丁，不要凭记忆重写：

   ```powershell
   curl.exe -L --fail https://github.com/icloud-photos-downloader/icloud_photos_downloader/pull/1367.diff -o primary-zone-1367.diff
   git apply primary-zone-1367.diff
   ```

   如果使用的是不含 `.git` 的源码压缩包，可以使用支持 unified diff 的补丁工具，或严格按照 PR 中的两个源码文件和新增测试文件应用修改。

3. 创建隔离环境并安装固定依赖：

   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -e .
   .\.venv\Scripts\python.exe -m pip install pytest==8.4.0 mock==5.2.0 vcrpy==7.0.0 freezegun==1.5.2 pytest-timeout==2.4.0 pyinstaller==6.14.0
   ```

4. 至少运行区域发现和图库相关测试：

   ```powershell
   .\.venv\Scripts\python.exe -m pytest tests/test_photos_zone_discovery.py tests/test_listing_libraries.py -q
   ```

5. 最后应用 `docs/icloudpd-inventory-indexing.patch`（在 recently-deleted 补丁之后）。它让只读时间统计在 FAILED / RUNNING 状态下先检查总数和成对元数据是否可读；不会放宽删除权限。Node 统计端在索引未完成时禁止接受小范围缺失，只有完整枚举成功才保存新统计、清除云端变化标记。失败时保留旧统计和标记，并明确显示重新统计失败原因。

   从源码根目录构建单文件 Windows 程序：

   ```powershell
   .\.venv\Scripts\pyinstaller.exe --noconfirm --clean `
     --collect-all keyrings.alt --copy-metadata keyrings.alt `
     --hidden-import pkgutil `
     --add-data "src/icloudpd/server/static:static" `
     --add-data "src/icloudpd/server/templates:templates" `
     --onefile src/starters/icloudpd.py `
     --name icloudpd-framebase-compatible
   ```

6. 将生成文件复制到约定位置，但不要覆盖官方原版：

   ```powershell
   Copy-Item .\dist\icloudpd-framebase-compatible.exe ..\..\icloudpd-framebase-compatible.exe
   ```

   根据源码目录层级调整目标路径，最终必须得到：

   ```text
   tools/icloudpd/icloudpd-framebase-compatible.exe
   ```

7. 运行 `--version` 并记录生成文件的 SHA-256，确认文件可执行。源码快照缺少官方构建元数据时，程序自身可能显示 `0.0.1`；FrameBase 会依据兼容文件名在界面显示 `1.32.3 · FrameBase 兼容版`。

   当前加入 FrameBase 只读时间清单、双向分页补扫、异常资源容错和精确删除适配器后的本机构建 SHA-256 为 `FA654F517154AD569ECB653E989D2157B78AF12992AD536028F0C3A4D9087B7E`。重新构建后哈希可能变化，应以新构建的测试结果为准，不能仅凭文件名判断是否包含补丁。

## FrameBase 时间清单扩展

上游 `--only-print-filenames` 只输出尚需下载的文件名，无法提供完整图库的拍摄时间和原始大小。FrameBase 兼容版在 `src/icloudpd/base.py` 的 `download_builder` 中增加了受环境变量保护的只读输出模式：

```text
FRAMEBASE_INVENTORY_JSON=1
```

该模式必须与 `--only-print-filenames` 一起使用。它在检查本地文件或下载之前，为每个云端对象输出一行：

```text
FRAMEBASE_INVENTORY {JSON}
```

JSON 只包含对象 ID、图库、文件名、拍摄时间、图片/视频类型、原始资源大小、Live Photo 视频大小和 RAW 标记。它不会下载文件，也不会调用删除接口。Provider 只解析带此前缀的行，逐项清单按 FrameBase 用户持久化在本机，用于安全释放时的精确匹配；浏览器普通日志不会输出清单。

兼容版还会在清单开始前输出 `FRAMEBASE_INVENTORY_TOTAL`，用于核对 Apple 图库总数。若正向分页得到的对象少于总数，FrameBase 会仅对该图库设置 `FRAMEBASE_INVENTORY_DIRECTION=DESCENDING` 进行渐进反向补扫，并按“图库 + 资产 ID”去重。补扫窗口从“缺失数 + 32”的安全余量开始（最低 64 项），不足时才扩大到 256、1,024，最后才回退为完整反向扫描。这用于规避 Apple Photos 分页在部分账户上提前结束、导致较早年份被误判为不在云端的问题，同时避免只缺少少量尾部对象时重读整个图库。没有总数缺口时不会补扫。带运行时密码的伪终端输出缓冲也必须提高到 128 MiB，否则大型图库清单会只保留末尾部分。

Apple 的 `HyperionIndexCountLookup` 可能包含少量已无法通过图库清单枚举的索引记录。大型图库在首次反向小窗口补扫没有新增项目、且差额不超过 32 项或总数的 0.5% 时，FrameBase 将记录该索引差异并立即停止扩大补扫，使用实际可枚举资产生成统计。较大差额仍视为扫描不完整，不能覆盖上次统计。这样可避免为固定的 `4670/4680` 差异重复执行 64、256、1,024 和全量反向扫描。

`FRAMEBASE_INVENTORY_TOTAL` 同时也是成功扫描的强制完成标记。只有明确收到 `count: 0` 时，FrameBase 才允许写入空图库；进程退出码为 0 但没有此标记时，必须视为 Apple 连接或兼容工具异常并保留旧统计。每次写入新的有效统计前，还会把上一版非空统计保存为当前用户隔离的 `timeline.previous.json`，用于防止异常覆盖。

只读清单必须在下载文件名消歧和版本选择之前执行。Apple 的图库总数偶尔包含缺少 `resOriginalRes`、`filenameEnc` 等下载字段的特殊资源；这些资源仍需用资产 ID、拍摄时间和可推断的媒体类型输出，未知大小记为 `0`。否则会出现总数为 4680、清单只有 4670 项，并导致整次统计因少数异常资源而无法更新。

重建时还必须运行：

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_framebase_inventory.py
```

该测试确认清单模式能输出元数据且不会创建媒体文件。不要把 Apple 密码或会话令牌放入环境变量；环境变量仅用于启用清单输出协议。

## FrameBase 精确删除扩展

官方 CLI 的 `--delete-after-download` 和 `--keep-icloud-recent-days` 只能按一次运行的处理范围删除，不能表达“只删除图片库中用户点选且已完成 SHA-256 备份的这一项”。FrameBase 兼容版因此增加内部协议：

```text
FRAMEBASE_DELETE_REQUEST=<受限权限的临时 JSON 文件>
FRAMEBASE_DELETE_COMMIT=1
```

- 请求文件最多包含 100 个目标，且包含云端资产 ID、图库、文件名、拍摄时间、媒体类型和原始资源大小。
- 兼容版遍历所选图库时只接受精确资产 ID，并再次逐项核对上述元数据；任何字段不一致都输出 `mismatch`，不调用 Apple 删除接口。
- 未设置 `FRAMEBASE_DELETE_COMMIT=1` 时只能 dry-run，输出 `matched`。FrameBase 每次正式删除前都会先完成一轮 dry-run。
- 提交模式复用 icloudpd 已有的 `delete_photo()`，按 `recordName` 与 `recordChangeTag` 更新单一 `CPLAsset` 的 `isDeleted=1`，结果是移入 iCloud“最近删除”，不是直接永久清除。
- 临时请求文件不包含密码或 cookie，由 Provider 创建在当前 FrameBase 用户自己的 session 目录下，进程结束后立即删除。目标 ID 不放入命令行。
- Live Photo 作为一个云端资产处理；本地 HEIC/JPEG 与配对 MOV 都必须验证成功后，才可匹配该资产。

FrameBase 业务层仍禁止向普通备份命令传入三个批量删除参数。兼容版源码与可执行文件位于被 Git 忽略的 `tools/`，所以每次从零构建时都必须手动恢复这一扩展，并运行 `tests/test_framebase_inventory.py` 以及 FrameBase 的 `tests/icloud-provider.test.mjs`。真实 Apple 账户删除不能作为自动化测试；测试必须 mock Apple `/records/modify` 或模拟兼容版机器输出。

### 单张及批量复核的查找优化

恢复上述精确删除扩展后，还需在兼容版源码根目录应用仓库中的 `docs/icloudpd-target-delete.patch`（`git apply --ignore-space-change <补丁绝对路径>`，兼容 Windows CRLF），然后重新运行测试及 PyInstaller 构建。该补丁随仓库保存，避免忽略目录下的优化随新工作副本丢失。

随后应用 `docs/icloudpd-delete-nameerror.patch`。它修复精确删除分支在 `core_single_run` 中引用未定义 `filename_builder` 的问题：使用当前用户的文件名策略与 Unicode 配置创建同样的文件名处理器。新增完整 CLI 回归测试先读取模拟清单，再执行精确 dry-run，并通过 mock 删除接口验证提交分支；这两个分支均必须返回正确结果，不能仅测试元数据助手或扫描迭代器。

最后应用 `docs/icloudpd-delete-completion.patch`。Windows 打包入口必须通过 `sys.exit(main())` 传播 CLI 返回的失败码；否则内部返回 1 仍会表现为进程成功。文件名模式关闭 logger 后，认证、网络及图库异常须输出脱敏 `FRAMEBASE_ERROR`；复核结束须输出 `FRAMEBASE_DELETE_DONE`。Provider 只有收到完成标记才可将未返回的目标判断为 `missing`；既无目标结果也无完成标记时应报告 `incomplete`，不能宣称目标不存在。会话验证通过 `FRAMEBASE_VERIFY_SESSION=1` 启用同样的脱敏错误协议。回归测试必须覆盖打包入口退出码、静默网络失败与正常完整复核。

Apple 返回 `Apple iCloud Photo Library has not finished indexing yet` 时，适配器输出 `photos_indexing`，Provider 报告 `indexing`。此时保留释放计划，等 Apple 完成索引后再验证图库、重试复核；不能绕过图库就绪检查或将这种状态当成“图片不存在”“Apple 会话失效”。网络、工具及索引错误均不应将已连接会话强制改成需要登录，只有明确的 `needs_auth` 才标记为过期。

### 区分索引失败与尚未完成

原始工具将 `CheckIndexingState` 的所有非 `FINISHED` 值统一抛为“尚未完成”。2026-10-09 的只读诊断发现当前账户主区域 `PrimarySync` 实际返回 `FAILED`，因此原先仅建议稍后重试的提示不充分。这是远端索引状态，不能通过重新生成本地释放计划修复，也不能绕过索引检查进行删除。

在上述补丁之后应用 [icloudpd-indexing-state.patch](icloudpd-indexing-state.patch)，然后重新打包兼容程序。补丁将索引状态和区域名称保留在异常及 `FRAMEBASE_ERROR` 诊断中。`FAILED` 输出 `photos_indexing_failed`，FrameBase 显示 `indexing_failed`；其他非完成状态继续显示 `indexing`。日志记录 `indexingState`、`zoneName`，不记录凭据。

索引失败时应打开对应区域的 iCloud 网页版照片，检查照片能否正常加载，以及是否出现初始化、修复或确认提示。不能仅凭 `FAILED` 判定图库不可读取或要求联系 Apple 支持；还需查询实际照片元数据。

### FAILED 状态的受限只读探测

后续只读诊断证实，在 `PrimarySync` 索引状态仍为 `FAILED` 时，照片数量接口返回 4679 项，首批 `CPLAsset` 与 `CPLMaster` 关联元数据也能读取。需要在索引状态补丁之后应用 [icloudpd-indexing-probe.patch](icloudpd-indexing-probe.patch)，然后重新打包。

回退仅用于带 `FRAMEBASE_VERIFY_SESSION=1` 或 `FRAMEBASE_DELETE_REQUEST` 的 FrameBase 操作，且仅针对 `FAILED`。初始化先查询正数项目总量和两项照片的首批元数据，要求资产记录能关联到原片记录。请求失败、零数量、元数据缺失或索引处于其他未完成状态仍会阻断。不会对工具的普通备份和其他命令全局关闭检查。

探测通过输出 `FRAMEBASE_INDEXING`，记录状态、区域和查询数量。会话验证会说明“索引状态虽为 FAILED，但照片数量和元数据可读取”。目标复核继续执行原有资产编号、图库、文件名、时间、类型、原片大小的逐项匹配。只有匹配通过的目标才可能提交删除；只读探测本身不会删除。回退模式下未返回全部目标，即使收到扫描结束标记也报告 `incomplete`，不能用不可靠索引推断照片已经消失。

最后应用 [icloudpd-target-bounds.patch](icloudpd-target-bounds.patch)。它合并相邻的缓存索引查找窗口，避免 5 个相邻目标因超过旧的 4 窗口限制而直接退回整库扫描。回退模式下，每个方向最多读取查询总量加 100 项，目标查找使用 90 秒时间预算，在读取返回后检查；单次网络请求仍可能额外等待其自身超时。超过预算或项目上限时返回已确认结果及 `incomplete`，不将未返回项目推断为不存在。普通工具命令继续保留原行为。

### 官网已删除的项目

再应用 [icloudpd-recently-deleted.patch](icloudpd-recently-deleted.patch) 并重建兼容程序。删除/复核先精确查找“最近删除”中的目标，仍检查资产编号、图库、名称、拍摄时间、类型和大小。已确认的项目输出 `alreadyDeleted: true`、`cloudState: recently_deleted`，不再次提交云端删除。选择“两边都删除”时重新校验本地原片后将其移入 Windows 回收站；不计入本次新释放的云端容量。

索引为 `RUNNING` 时，允许受限只读探测和最近删除查询；未确认已在最近删除中的项目仍阻止主动云端删除。永久删除、超过保留期、或查询未找到的项目不视为已删除，可由用户使用现有“仅删除本地”操作独立回收。

- FrameBase 根据上次只读清单中同一图库的顺序传入 `lookupRank`。它只是查找提示，不能作为匹配或删除依据。
- 对最多四个提示位置先扫描附近最多 300 项；目标未找到则回退到从头扫描，正向分页漏项时再反向补扫。目标全部找到后立即结束，不再遍历剩余图库，也不再为删除预先查询整库数量。
- 所有路径继续核对精确 ID、图库、文件名、拍摄时间、媒体类型和原始资源大小；过期索引提示不会放宽校验。
- 工具输出 `FRAMEBASE_DELETE_PROGRESS`，包含累计扫描数、剩余目标数及扫描方向。复核通过后台任务运行，页面每秒读取状态，刷新后可恢复进行中的复核。确认前始终为 dry-run。
- 失败时保留会话失效、连接异常、目标未找到或元数据不一致的具体原因。较大的图库或 Apple 网络延迟仍可能耗时超过 100 秒，不能承诺固定秒数。

Python 模拟测试遇到 Windows 系统代理干扰 VCR 录制匹配时，可仅在测试进程设置 `$env:NO_PROXY='*'`。这不会修改实际应用的代理配置。

### 会话验证与删除认证

`/icloud` 和图片库调用同一个 `/api/icloud/verify`，按当前 FrameBase 用户使用同一会话目录及同一份仅存于进程内的 Apple 密码。验证先执行 `--auth-only`，再以 `--recent 1 --only-print-filenames` 只读检查照片图库；只登录成功不能证明图库访问正常。两次检查都通过才显示验证成功。

图片库删除窗口提供会话验证及 Apple 密码/验证码登录入口，登录完成后自动执行上述验证。验证不会提交删除，用户仍需重新复核并确认删除。错误分类必须使用明确的认证错误，不能仅因 traceback 或密码提示中含有 `password`、`authentication` 就把其他异常报告为会话失效。密码交互终端的提示可能与机器结果共用一行，删除解析器应从协议标记开始解析，并继续验证目标 ID 与图库，不能把完整终端输出显示给用户。

### 云端与本地同时清理

逐项释放时，用户可以选择只把云端资产移入 iCloud“最近删除”，或在云端成功后继续把本地备份移入 Windows 回收站。顺序不可颠倒：

1. 再次完成本地大小和 SHA-256 复核。
2. 对云端资产执行精确 dry-run。
3. 用户输入确认文字后，将云端资产移入“最近删除”。
4. 只有云端返回成功，才调用独立的 Windows 回收站适配器处理本地文件。
5. Live Photo 的主图片和配对 MOV 作为一组处理。

本地路径只从已验证清单解析，必须位于当前用户备份根目录内；路径通过子进程环境传递，不拼接进 PowerShell 命令。云端和本地结果分别持久化。本地部分失败不会回滚已经成功的云端操作，但 `/icloud` 会显示失败数量并提供“重试本地回收”。自动化测试使用模拟回收站，不得删除真实文件。

## 只读验证顺序

先验证会话，再验证图库，最后才允许小规模备份。诊断阶段禁止加入任何删除参数。

1. 使用用户隔离的 cookie 目录运行 `--auth-only`。
2. 运行 `--list-libraries`，确认能够发现主图库和共享图库。
3. 运行 `--recent 10 --only-print-filenames`，确认能列出真实媒体文件名。
4. 在 FrameBase `/icloud` 页面执行“扫描最近 10 个项目”。
5. 仅在扫描成功后执行一次“安全备份最近 3 个”。FrameBase 会验证文件存在、大小非零并记录 SHA-256。

严禁在扫描和测试备份流程中出现：

```text
--auto-delete
--delete-after-download
--keep-icloud-recent-days
```

当前安全备份 API 还会限制每个 FrameBase 用户只能成功执行一次测试备份，避免反复点击扩大下载范围。

## 认证与隐私要求

- Apple ID 密码和六位验证码只能通过本机伪终端的标准输入传给 `icloudpd`。
- 不得把密码放入命令行参数、环境变量、配置文件、日志、测试夹具或 Git。
- cookie 会话目录为 `.framebase-icloud/<FrameBase 用户名>/session`，也被 Git 忽略。
- 每个 FrameBase 用户拥有独立的配置、cookie、扫描清单和备份清单。
- 兼容性诊断不要使用 `--log-level debug` 保存长期日志；调试输出可能包含账户或会话元数据。

## 容易重复踩到的问题

| 现象 | 优先检查 |
| --- | --- |
| 网页有照片，认证成功，但扫描为 0 | 是否仍在使用官方 `1.32.3`；兼容程序是否包含 PR #1367 |
| FrameBase 显示官方版而不是兼容版 | `tools/icloudpd/icloudpd-framebase-compatible.exe` 是否存在；是否设置了 `FRAMEBASE_ICLOUDPD_PATH` |
| 命令行可列出照片，网页仍显示 0 | FrameBase 后台是否以允许访问 Apple 网络的本机环境启动；重启服务后再测 |
| FrameBase 重启后要求重新输入密码 | 先调用“验证已有会话”；Provider 应使用已保存 cookie，并以 `--password-provider parameter` 做非交互检查 |
| 双重验证码总是不正确 | 必须使用本次登录请求新生成的验证码；旧会话或上一轮验证码会失效 |
| 重复测试备份继续下载 | 使用包含一次性保护的当前 FrameBase 版本；成功测试后 API 应返回 409 |

## 已验证基线

### 按记录编号直接定位

在上述补丁之后应用 [icloudpd-direct-lookup.patch](icloudpd-direct-lookup.patch)，并按前文步骤重新构建、替换兼容程序。只读清单新增 `lookupAssetRecordName`，FrameBase 会将它保存在时间统计和释放计划中；旧清单仍可使用分页查找。首次成功复核会在 Provider 中缓存目标记录编号，按 Apple 账户、区域、会话目录和图库隔离，最多缓存 1000 项，让后续正式删除优先直接定位。

兼容工具对 `/records/lookup` 分批读取最新 CPLMaster 和 CPLAsset，每批最多 100 个记录，检查原片关联、最新变更标签与删除状态，再进入原有 ID、图库、名称、拍摄时间、类型和大小的精确校验。记录编号只是定位提示；不使用本地缓存的变更标签或缓存元数据提交删除。目标已经在“最近删除”时不重复提交云端删除；索引 RUNNING 仍阻止主动删除。旧提示、错误关联、接口失败或不完整返回会退回现有受限分页查询，不能据此判定目标不存在。

重新读取云端时间统计后，新清单中的目标可在首次复核时使用直接定位。未更新的清单首次复核仍可能扫描，成功复核到正式删除之间可复用确认后的记录编号。真实 Apple 接口不支持直接定位时仍会回退，因此不能保证所有账户都跳过分页；当前验证为模拟接口回归，没有提交真实云端删除。

回归命令（源码根目录）：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_framebase_direct_lookup.py tests/test_framebase_deleted_targets.py tests/test_framebase_target_bounds.py tests/test_framebase_inventory.py -q
```

本次构建 SHA-256：`EAEA99BE680B52BB10E70E593CCB33D701B9310489019FAAA72D5250EA9FDAF8`。

本兼容方案在 Windows、`icloud.com.cn` 区域完成过以下验证：

- Apple ID 与双重认证成功。
- `--list-libraries` 能发现主图库和共享图库。
- 只读扫描能返回最近 10 个真实媒体项目。
- 少量测试备份写入用户独立目录，未删除 iCloud 原文件。
- 本地备份清单记录文件大小和 SHA-256。

这份基线只证明当前兼容路径可工作，不代表已经授权完整下载或云端删除。释放 iCloud 容量必须另行实现并经过明确确认。
