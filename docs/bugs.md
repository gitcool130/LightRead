# Bug 记录

## BUG-20261025-001：Surface 语文 PDF 教材封面空白

- 状态：**已修复并在 Surface 现场验收（2026-10-26，桌面 v2.3.1）**，见文末「修复记录」与「Surface 验收」。
- 用户反馈：Windows Surface 版教材封面加载不出来，手机版正常。
- 环境：Surface Pro 9，Windows 10 企业版 LTSC / 10.0.19044 / x64，LightRead 桌面版 2.3.0。
- 样本：《义务教育教科书·语文六年级上册》，书籍 ID `fffbecd0-e674-46bd-9d09-58f42167bb1c`，来源字段为 `教材`。

### 已验证的现场证据

通过 `ssh surface` 只读检查文件，并复制 SQLite 数据库到控制台检查：

| 项目 | 实际结果 |
| --- | --- |
| 书库目录 | `C:\Users\wecode\AppData\Roaming\com.yzfly.lightread` |
| 正文文件 | `books/fffbecd0-e674-46bd-9d09-58f42167bb1c.pdf`，17,014,217 字节 |
| 封面文件 | `covers/fffbecd0-e674-46bd-9d09-58f42167bb1c.jpg`，**0 字节** |
| 数据库 | `books.has_cover = 1` |
| 其他封面 | 其余 29 个封面文件均非空；未逐张验证解码 |
| 书目 added_at | 2026-10-19 12:09:03.494 UTC |
| Surface 封面创建及修改时间 | 2026-10-22 17:02:21.741 UTC |

直接原因：本地 JPG 没有图片数据，但数据库标记为有封面。上述时间差只能提示可能经过同步或恢复，**不能据此认定空文件来自同步，也未定位最初产生空文件的具体操作**。未读取手机上同一本书的封面进行字节对比；手机正常来自用户反馈。正文文件非空，尚未就此样本验证完整 PDF 渲染。

### 代码定位与缺陷链路

1. `src/storage/tauri.ts`：`insertBook`、`setCover` 按 Blob 对象是否存在写封面并置 `has_cover=1`，没有检查 `cover.size`；空 Blob 也可能被认作有效封面。
2. 同文件 `getCoverUrl`：读取封面后直接创建 JPEG Blob URL，不检查字节数或图片可解码性。空文件读取成功时仍返回地址。
3. `src/stores/library.ts`：`refresh` 只为 `hasCover` 为真的书异步读取封面，没有损坏封面修复流程。
4. `src/components/BookCard.vue`：`v-if="coverUrl"` 决定显示图片，没有图片 `error` 回退；损坏图片仍占据图片分支，文字封面不会显示。
5. `src/services/importer.ts`：`extractPdfMeta` 通过 PDFium 渲染第一页并 `canvas.toBlob` 生成封面；异常被吞掉。尚无证据证明这次空文件由这里产生。
6. `src/services/sync/engine.ts`：`downloadBook` 接收远端封面后直接传给存储，没有空内容校验；上传侧 `readCover` 已检查 `blob.size`。这是待排查入口，不是已确认根因。

### 修复范围

- 修复存储入口：空封面不得写成有效封面，数据库标记与实际有效文件保持一致；评估桌面与 App 共用路径及网页存储。
- 修复读取与显示：空文件、缺失文件、无法解码的图片均应安全回退到文字封面；图片加载错误也要触发回退，避免反复请求。
- 修复已有损坏数据：支持从本地 PDF 第一页重新生成封面，写入成功后更新标记与缓存，不要求用户删除书籍或重新导入；失败时保留正文、进度、批注及其他元数据。
- 继续追查空文件产生入口，特别是同步、恢复与封面写入；证据不足时保留未确定结论。
- 检查同步是否会一直保留远端损坏封面，或因书目已存在而不修复本地损坏封面，避免修复后再次复发。

### 验收要求

1. 零字节封面且 `has_cover=1`：立即显示文字回退，成功补生成后显示真实封面；重启后仍正常。
2. 缺失文件、非空但损坏图片：也能回退；修复失败不会影响书籍阅读。
3. Surface 上该教材实际恢复封面，PDF、阅读进度及其他元数据保留；保留修复前后证据。
4. 正常封面不受影响；手机端共用存储与同步行为不回归。
5. 覆盖必要的空 Blob 写入、损坏图片回退、已有数据恢复与缓存更新验证；构建和测试遵守项目 `CLAUDE.md`，重任务放 T9。

### 接手注意

操作 Surface 前读取 `/home/ubuntu/.agents/test-devices.md` 并探活；不要卸载、清库、重启设备或结束用户进程。修复现场文件前备份目标封面及必要的书目状态。用户工作区已有未跟踪设计草稿，不属于此 bug，勿改动。当前控制台数据库诊断副本为 `/tmp/lightread-surface-diagnosis.db`，仅供临时参考，以设备实时状态为准。

### 修复记录（2026-10-25）

改动（桌面与 App 共用存储 / store，网页 IndexedDB 同步修复）：

- `src/services/coverRepair.ts`（新增）：`isUsableCoverBytes` 只看文件头判定封面可显示（非空且为 JPEG / PNG / GIF / BMP / WebP / AVIF）；`createCoverResolver` 在 `hasCover` 为真但封面不可用时，从书籍文件重新生成并写回，书里取不到封面就清标记；重新生成出错（可能是暂时的）保留标记、下次启动再试；每本每次运行只修一次，并发刷新共用一次修复。
- `src/storage/tauri.ts`、`dexie.ts`：写入时空 Blob 不算封面（`insertBook` / `addBook` / `setCover`），因此同步下载的空远端封面、备份恢复的空封面也不会再被标成有封面；`getCoverUrl` 对空文件 / 非图片返回 `undefined`；新增 `clearCover`，网页端补 `setCover`。同步上传与备份经 `getCoverUrl` 取封面，不再传播损坏封面。
- `src/services/importer.ts`：新增 `regenerateCover`，取法与导入一致（PDF 第一页、EPUB 原生、DjVu、CBR、foliate 格式）；PDF 渲染失败时抛错，不再被当成没有封面。
- `src/stores/library.ts` 与 `src/mobile/stores/library.ts` 改用修复流程；`BookCard.vue` 与 App `BookCover.vue` 的图片解码失败时回退文字封面。
- 新增 `npm run test:cover-repair`（已加入 release 预检）和 `npm run e2e:cover-repair`。

验证（T9，`~/tokenssh-build/runs/lightread-cover-fix-20261025`）：`vue-tsc -b` 通过；`test:cover-repair` 9/9、`test:sync-engine` 13/13、`test:sync-large-files` 5/5、`test:sync-merge` 40/40、平台边界 3/3；桌面与 App 平台 `npm run build` 通过；`e2e:cover-repair` 5/5（PDF 0 字节封面重启后由第一页重新生成为 JPEG、阅读进度保持；非图片封面同样修复；TXT 带错误标记时清标记并显示文字封面）；`npm run e2e` 37 步全部通过、无页面错误。

未完成 / 已知限制：

- 未找到空文件的最初来源。现在所有写入口都会拒绝空封面，但旧版本已写到同步远端的空 `.cover` 文件仍会留在远端（上传只看文件是否存在，不比较大小）；拉取到它的设备不写封面，由本地重新生成兜底。
- 「文件头正常但数据截断」的图片仍按可用处理（能显示一部分）；完全无法解码的图片在卡片上回退文字封面，但不会触发重新生成。

### 发版与 Surface 验收（2026-10-26）

- 桌面 `v2.3.1` 已发布（GitHub latest，8 个安装包 + `SHA256SUMS`，不含 APK；release workflow 的 preflight、rust-floor、四个平台构建与 publish 全部成功）。GitCode 镜像按用户决定暂缓：CI 无 `GITCODE_TOKEN`，本机 CLI 打印令牌需交互确认；GitCode 目前最新仍是 v2.2.5（v2.3.0 也未镜像）。
- Surface：先备份封面与书库数据库，经用户同意强制结束 2.3.0（从 SSH 会话无法正常关闭；WAL 为 0 字节、数据库最后写入早于操作），用经 `SHA256SUMS` 校验的安装包 `/S` 静默安装 2.3.1，再用一次性交互计划任务在桌面会话启动（任务已删除）。
- 结果：启动后封面由 PDF 第一页重新生成，0 字节 → 39,850 字节完整 JPEG（`ff d8 … ff d9`），内容为教材真实封面；重启后封面未被再次生成（修改时间与大小不变）。修复前后数据库逐字段比对：34 本书全部字段一致（本书 `has_cover=1`、进度 0.549 / 位置 78、阅读 330 秒、来源「教材」均不变），批注、书单条目数不变。桌面截图显示「继续阅读」卡片的真实封面。
- 证据与回退文件在 Surface `%USERPROFILE%\lightread-backup-BUG-20261025-001\`：`pre-update\`（0 字节封面与修复前数据库）、`post-update\`（修复后封面与数据库）、`library-after.png`。
