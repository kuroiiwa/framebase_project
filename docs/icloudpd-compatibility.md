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

5. 从源码根目录构建单文件 Windows 程序：

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

   当前加入 FrameBase 只读时间清单能力后的本机构建 SHA-256 为 `8116AE89652A13A09A05800890CE65EF3AF36DCF42829D6DC618928D69193245`。重新构建后哈希可能变化，应以新构建的测试结果为准，不能仅凭文件名判断是否包含补丁。

## FrameBase 时间清单扩展

上游 `--only-print-filenames` 只输出尚需下载的文件名，无法提供完整图库的拍摄时间和原始大小。FrameBase 兼容版在 `src/icloudpd/base.py` 的 `download_builder` 中增加了受环境变量保护的只读输出模式：

```text
FRAMEBASE_INVENTORY_JSON=1
```

该模式必须与 `--only-print-filenames` 一起使用。它在检查本地文件或下载之前，为每个云端对象输出一行：

```text
FRAMEBASE_INVENTORY {JSON}
```

JSON 只包含对象 ID、文件名、拍摄时间、图片/视频类型、原始资源大小、Live Photo 视频大小和 RAW 标记。它不会下载文件，也不会调用删除接口。Provider 只解析带此前缀的行，并在内存中汇总为年份、季度和月份；原始逐项清单不会写入浏览器或普通日志。

重建时还必须运行：

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_framebase_inventory.py
```

该测试确认清单模式能输出元数据且不会创建媒体文件。不要把 Apple 密码或会话令牌放入环境变量；环境变量仅用于启用清单输出协议。

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

本兼容方案在 Windows、`icloud.com.cn` 区域完成过以下验证：

- Apple ID 与双重认证成功。
- `--list-libraries` 能发现主图库和共享图库。
- 只读扫描能返回最近 10 个真实媒体项目。
- 少量测试备份写入用户独立目录，未删除 iCloud 原文件。
- 本地备份清单记录文件大小和 SHA-256。

这份基线只证明当前兼容路径可工作，不代表已经授权完整下载或云端删除。释放 iCloud 容量必须另行实现并经过明确确认。
