# LightRead 轻阅

开源、本地优先的电子书 / 论文阅读器。桌面 (Tauri 2) + 网页 PWA + Android 实验版。
产品定位与已定决策见 `docs/产品设计.md`，论文阅读链路见 `docs/paper-reading.md`。

## 分支分工（2026-10-17 用户确认）

- `release/1.20.0`：1.x 全平台最终版封存分支，tag `v1.20.0`；已发布内容不混入 2.0 开发。
- `Dev`：后续 App 2.0 开发主线，工作目录 `/home/ubuntu/workspace/LightRead-v2`。原 `feat/lightread-2.0` 只保留历史。
- `main` 保持原有代码。**2026-10-22 用户确认：桌面与 App 对齐，从 v2.2.0 起同一分支 (`Dev`)、同一提交、同一版本号发布全平台 `vX.Y.Z`**；桌面直接从 tag 源码构建，不再用 `scripts/desktop-release.json` 固定旧基线 (已删除；workflow 只在该文件存在时走基线补丁)。不维护桌面 / App 两条分支：共享层 (存储、同步、阅读引擎、全部 Rust) 一处修复两端生效，界面差异仍由 `src/mobile/` 覆盖清单隔离。
- 新版统一使用 `vX.Y.Z` 全平台 Release，完整校验后设为 GitHub latest；GitCode 保留旧版与字体资源（`KEEP_OLD=1`）。历史 `app-v2.0.0` 保留，不能移动或删除；该旧 APK 只识别 `app-v2.x`，首次高于 2.0.0 的后续版本还需发布同 APK 的 `app-vX.Y.Z` 兼容入口（latest=false），供旧 App 迁移到统一更新器。
- Release 标题仅使用版本号。App 默认在线语音；K30 已将旧离线选择改为在线，后续测试恢复设置时不要改回离线。

## 本次 App PDF 发布（2026-10-20 用户确认）

- PDF 双形态阅读仅属于 App，正式版本 `app-v2.1.0`；桌面和默认 Web 保持原版 PDF 路由，桌面 latest 保持 `v2.0.0`。
- App 入口在 `src/mobile/views/`，PDF 路由由 `src/mobile/services/readerRoute.ts` 经覆盖清单启用；引擎可放共享服务，但不能把 App 的入口带入桌面。
- (历史) 当时基础／桌面版本为 2.0.0，Android／iOS 为 2.1.0，桌面固定旧基线。误建的统一 `v2.1.0` Release 已撤回为草稿，不能重新公开；2.2.0 起版本对齐，见上文分支分工。
- K30 覆盖升级与数据保留已验证；用户明确同意注明安全锁屏导致的前台交互验收限制并继续发布，不把受阻项计为通过。

## K30 真机验收（2026-10-18 用户要求）

完整验收先设计测试计划与能力清单，再自顶向下逐项点击每个栏目、窗口、功能和按钮。阅读样本用《理想国》和 K30 已有书籍，不以短合成文本代替长文验收；不为节省耗时省略检查。逐项记录实际结果、证据、缺陷和受阻条件，遵循 [K30 验收约定](docs/testing/k30-ui-acceptance.md)。

## App / 桌面版本边界（2026-10-22 用户更新）

桌面、默认 Web/PWA 与 App 版本一致 (`package.json`、`tauri.conf.json`、`tauri.android.conf.json`、`tauri.ios.conf.json`、Cargo 同步修改，`scripts/test-platform-boundary.mjs` 校验)；界面仍按平台隔离。App 专属界面在 `src/mobile/`，通过构建平台选择，不能用窗口宽度决定产品界面。能复用的能力放共享层：桌面借鉴 App 的设计 (配色令牌、生成封面、继续阅读、论文状态筛选、Sec-MS-GEC v2 语音) 时改桌面自己的文件，不直接引用 `src/mobile/`。详见 `src/mobile/README.md`。

## 技术栈

- 前端: Vue 3 `<script setup>` + TypeScript + Vite 8 + Pinia + vue-router (hash 路由，兼容 Tauri file 协议)
- 桌面壳: Tauri 2 (Rust, `src-tauri/`)；网页版部署到 Cloudflare (`wrangler.jsonc`, `relay/`)
- 阅读引擎: foliate-js (EPUB/MOBI/AZW3/FB2/CBZ + 转成内存 EPUB 的 TXT/HTML/MD)，PDF 走 MuPDF / PDFium wasm，DjVu 走 `src/vendor/djvu.js`
- 存储: `src/storage/` 的 `LibraryStorage` 抽象 — 桌面 `tauri.ts` (文件 + SQLite)，网页 `dexie.ts` (IndexedDB)
- 无 UI 组件库、无 Tailwind：样式全部是手写 CSS + `src/styles/main.css` 里的设计令牌

## 构建机 (2026-10-22 用户要求)

编译、测试、打包等重活一律放 **t9 服务器** (`ssh t9`, 本机隧道 127.0.0.1:2203, 用户 jiangshu, 8 核 / 约 380 GB 空闲), 避免占用本机性能和磁盘。
t9 的 Rust 在 `~/.cargo/bin`, 非交互 shell 不在 PATH, 远程执行先 `source ~/.cargo/env` (或 `bash -lc`)。本机只做编辑、轻量检查和 git。

## 常用命令

```bash
npm run dev                 # vite 开发服务器, 固定 5173 端口 (strictPort)
npm run build               # vue-tsc -b && vite build
npm run android:build       # 本机打 Android APK (固定 CARGO_PROFILE_DEV_DEBUG=0 + clean + 固定签名, 打完校验无调试符号); 不要手敲 tauri android build
npx vue-tsc -b              # 只做类型检查
npm run test:paper-agent    # 论文 Agent 前端契约 (node --test)
npm run test:paper-context / test:keyboard-shortcuts / test:archive
npm run test:sync-merge / test:sync-engine / test:sync-account / test:sync-settings   # 多端同步: 合并纯函数 + 引擎 + 账号 + 设置同步 (假存储/假远端)
npm run test:sync-large-files   # 同步大文件: 分块 SHA-256 / 原生算指纹不读文件 / 暂存文件下载与校验
npm run test:reading-log    # 阅读记录: 计时规则 + 每日统计 + 多端同步往返
npm run test:compat / test:tts   # 旧 WebView 兼容 (构建目标/polyfill/CSS 回退); 离线听书调度
npm run test:reader-pages / test:listen-eta   # 重排书页码 (实测+推算/双栏/跳页往返); 听书剩余时间 (语速学习/人话时长)
npm run test:read-aloud      # 听书: 句子游标断句 + 播放管线 (分块/预取/无缝拼接/回退, 假时钟) + 音色目录
npm run test:reading-modes   # 阅读模式: 打字机出字节奏 / 断句 / 按行分组 (纯函数)
npm run test:reading-focus   # 阅读焦点: 舒适区 25%–65% / 焦点线 38% / 长句 / 手动滚动后暂停跟随 (听书跟随与跳转落点, 纯函数)
npm run test:reader-tap-zone # 轻点分区: 横屏左·中·右 / 竖屏上·中·下 / 自动阅读时无翻页区 (纯函数)
npm run test:display-title   # 手机书架短书名 / 短作者: 只去末尾长营销括注, 作者取分号前第一段 (src/services/displayTitle.ts)
npm run test:zh-segment      # 仿生阅读中文分词: 词表切分 / 歧义不上色 / ICU 回退 / 交替规则 / 速度 (<15ms/万字)
npm run test:key-words       # 点睛重点词: 本书新词发现 / 自信息 + 关键度 + 聚集度打分 / 密度与间隔 / AI 词定位与回退 (设计见 docs/research/entropy-keyword-highlighting.md、llm-keyword-selection.md)
npm run test:terminology     # 术语来源完整性 / 22 类路由 / 原文跨度 / 边界与预算
npm run test:concept-recognition # 生产完整概念边界 / 智能碎片扩展 / 失败回退
npm run test:auto-scroll     # 多刷新率速度 / 卡帧与调速 / 亚像素累计
npm run audit:keywords       # 离线复现词边界、同形词跨语境和未来新词影响; 不是准确率评测
node scripts/build-terminology.mjs   # 重建开放候选词库与覆盖报告; 方案见 docs/research/keyword-optimization.md
node scripts/build-zh-lexicon.mjs   # 重新生成中文词表 src/data/zh-lexicon.txt + 回退合并表 zhMergeWords.ts (下载 jieba / DeepSeek-R1 词表到 ~/.cache, 校验 SHA-256)
npm run test:book-sources    # 公共书源: 查询归一 / 哲学文库·研辞问典本地索引搜索 / 教材分卷合并与排序 / IA·Open Library·GitHub 相关度
node scripts/build-philosophy-index.mjs   # 重新生成哲学文库离线索引 src/data/philosophy-index.json (限速抓目录页, 约 5 分钟)
node scripts/build-wendian-index.mjs      # 重新生成研辞问典离线书目 src/data/wendian-index.json (sitemap + 分类列表页, ≤1 次/秒, 约 17 分钟; 不碰站内搜索)
npm run test:opds-library / test:library-upload   # 自建书库: 连接信息解析·搜索发现·EPUB 优先; 上传协议
npm run test:native-drop    # 桌面原生拖放事件与批次队列; e2e:native-drop 连接 Vite dev, 模拟 IPC 验证导入全流程
cargo test --manifest-path src-tauri/Cargo.toml library_import --lib  # Rust 文件/文件夹扫描与复制暂存 (在 t9 执行)
npm run test:folder-pick / e2e:folder-pick   # 选择文件夹导入 / 上传: 递归找书 + 按格式推荐度去重
npm run e2e:continuous-scroll   # 跨章连续滚动: 逐帧触摸 + 惯性跨章, 无回跳 / 预载 / 插入上方不跳 (设计见 docs/continuous-scroll.md)
npm run test:plain-text      # 通用纯文本: 源码/配置/日志/无扩展名文件识别 · 内容嗅探 · 代码视图 (行号/分块), 按 txt 入库 (src/services/plainText.ts)
npm run test:pdf-reflow / e2e:pdf-reflow # App PDF 重排契约／双形态浏览器测试（App 预览加 E2E_MOBILE=1）
npm run test:convert-epub    # 格式转换: MOBI/AZW3/FB2/TXT → EPUB 3 (OPF/nav/资源改写)
npm run test:transfer / test:qr   # 互传: 三种通道 (账号 / WebDAV / 取件码) 纯逻辑; 无依赖二维码编码
npm run test:booklists / e2e:booklists   # 书单: 待找匹配·自动归入·分享导入·推荐书单校验; 浏览→找书→加入→分享→导入 (node scripts/build-booklists.mjs 用 Wikidata 重建奖项书单)
npm run e2e:transfer         # 互传端到端: 本地 wrangler sync-server + 内嵌 WebDAV, 预览默认 4186 (E2E_BASE 可改)
npm run e2e:convert-epub / e2e:library-upload / e2e:book-sources   # 对应功能的浏览器端到端 (需先 build + preview)
(cd sync-server && node --test test/api.test.mjs)                  # 账号后端契约 (wrangler 本地运行时)
cargo test --manifest-path src-tauri/Cargo.toml agent   # 论文 Agent 原生契约
cargo test --manifest-path src-tauri/Cargo.toml ipc_contract   # 书库原生命令 IPC 契约: 藏书包原生导出/导入、换书库文件夹、改名 (前端实际 JSON 参数)
npm run test:zh-segment-wasm   # 中文分词核心 Rust/wasm 与 JS 逐位一致 + 整条重点词管线不变; 改 wasm/zh-segment 后先 scripts/build-zh-segment-wasm.sh
node scripts/gen-epub-meta-golden.mjs   # 升级 foliate-js / 改导入取元数据规则后: 重生成 Rust 原生 EPUB 元数据的期望, 再跑 cargo test epub_meta
node scripts/gen-txt-epub-golden.mjs   # 改了 TXT 分章 / 段落规则后: 用前端 convertToEpub 重生成 Rust 原生 TXT→EPUB 的逐字节期望 (需 vite 开发服务器 5180), 再跑 cargo test txt_epub
scripts/build-ui-font.sh   # 重新生成桌面展示字体子集 (霞鹜文楷, 只含界面词典用到的字); 改标题类文案后重跑
npm run tauri dev|build     # 桌面 (需要 Rust 工具链)

# 端到端冒烟 (Playwright): 先构建并起预览, 再跑脚本 (脚本写死 http://localhost:4173)
npm run build && npx vite preview --port 4173 --strictPort &
npm run e2e                 # scripts/e2e-smoke.mjs, ~35 步: 导入 → 书单 → 阅读器 → PDF → 持久化
npm run e2e:mobile          # scripts/e2e-mobile.mjs: 15 款手机竖屏 × 主要页面, 查横向溢出/触控目标/安全区遮挡, 报告 /tmp/lightread-mobile (STRICT=1 有 error 即失败)
npm run e2e:sync            # 内嵌 WebDAV, 两个浏览器上下文互相同步 (协议见 docs/sync.md)
npm run e2e:account         # 本地 wrangler 起 sync-server, 两台设备走邮箱验证码登录并同步
BIG_TXT=… PDF_FIXTURE=… node scripts/perf.mjs   # 性能基准 (打开/翻页/PDF + 长任务), 账本见 docs/perf-ledger.md
```

- 每次 `vite build` 后要**重启** `vite preview`（Cloudflare 插件会缓存资源清单，否则页面空白报 MIME 错误）。
- e2e 首次运行需要 `npx playwright install chromium`。

## 目录速览

```
src/
  App.vue              应用壳: 侧栏 / 平板图标栏 / 手机底部标签栏, 更新按钮
  views/               LibraryView(藏书+论文共用) ReaderView(foliate) PaperReaderView(PDF, 6.5k 行) DjvuReaderView CatalogView SettingsView
  components/          BookCard TocList ToastHost PaperAgentSidebar BabeldocTaskStatus
  stores/              settings.ts (localStorage, 带 SETTINGS_VERSION 迁移) library.ts
  services/            纯函数 / 平台适配: importer, opds, arxiv, tts, ai, paperAgent*, backup, appearance …
  services/sync/       多端同步: types(契约) merge(纯函数) engine(编排) webdavRemote baseline(IndexedDB lightread-sync)
  i18n/                zh.ts (默认, 缺失回退来源) en.ts; t(key, params) 纯函数, key 为 'area.name' 字符串
  styles/main.css      设计令牌 + 全局组件类 (.btn .input .card .tag .segmented .modal .toast .empty .skeleton)
scripts/               e2e-smoke.mjs e2e-full.mjs perf.mjs 各类 node --test 契约测试
src-tauri/src/         Rust 命令: agent/ babeldoc calibre edge_tts local_tts fonts
sync-server/           轻阅账号后端 (Cloudflare Worker + D1 + R2, sync.jiangshu.ai), API 见 docs/account-api.md
```

## 约定

- **能用 Rust 就用 Rust（2026-10-22 用户要求）**：文件读写、哈希、下载、格式解析等重活优先写成 `src-tauri/src/` 的原生命令，提升质量与性能；前端只做界面和编排。安卓 WebView 的 IPC 会把字节数组序列化成 JSON 数字数组，大文件不要整本经 `plugin-fs` 进出 JS（导入走 `library_file_write_chunk`，同步走 `library_file_download` / `library_file_sha256`，见 issue #14）。网页版没有原生层，保留 JS 实现作回退。哪些已原生、哪些留在 JS 及实测依据见 `docs/rust-native-audit.md`，新增候选先对照它。
- **样式只用语义令牌**（`--bg --card --surface-2 --text --text-2 --text-3 --border --brand --brand-light --danger --success …`），不要在组件里写裸色值。深色模式通过 `<html data-theme="dark">` 重定义令牌实现，由 `services/appearance.ts` 依据 `settings.appearance` (system/light/dark) 写入。
- 全局类 `.segmented` 是设置页等的分段控件；阅读器工具栏各自有 scoped 的 `.seg`，不要合并。
- 图标一律内联 SVG（`aria-hidden="true"`），不用 emoji 当图标；图标按钮必须有 `aria-label`/`title`。
- 触屏设备不依赖 hover：`@media (hover: none)` 下提供可点的替代（如 BookCard 的「更多」按钮）。
- 所有用户可见文案走 `t()`，中英两个字典同时加 key，放在对应分区（`// ---- 藏书 ----` 等）。
- UI / UX 需求先从全局检索同类入口，优先统一控件与交互；不只修反馈截图里的单点。应用内选择和确认使用 `AppSelect` / `AppModal` / `askConfirm`，不新增原生 `<select>` 或 `alert` / `confirm` / `prompt`。文件选择、权限和安装器属于系统能力。
- 全局排查不等于扩大改版范围。替换弹窗时保留所在页面原有布局与触发控件尺寸；未明确要求改版的页面不得顺带重排。藏书页手机端 (≤720px) 已按 2026-10-17 用户确认的原型改版：标题 + 今日 + 圆形「＋」/ 吸顶搜索 / 继续阅读卡 / 列表标题 (范围·排序·选择) / `BookCard compact` (封面只留进度条, 「⋯」在作者行, 长按进入选择) / 选择模式底部 4 项操作栏；添加、书卡操作、批量更多都走 `AppModal` 底部面板。论文 / 书源 / 阅读记录 / 设置的手机端 (≤720px) 按 2026-10-17 用户确认的原型改版：论文页为状态 + 标签筛选与列表行 (`services/paperState.ts`)；书源页按 2026-10-18 已确认原型修正为搜索范围选择窗口、公共书源／私人书库／个人书单分组，社区目录折叠；推荐书单按 2026-10-18 用户要求归入藏书 → 书单，放在个人书单下方，不再放在书源页；藏书的「书单」为页内列表，管理独立打开；设置页为账号卡 + 分组列表，二级页复用原分区并由 `?page=` 驱动。桌面布局保持原样，不要把手机改版带到桌面。
- 手机文案按实际宽度检查换行；超过两行的界面说明逐项审阅，优先精简或按需展开。保留关键风险信息，不截断书籍正文、用户内容和必要错误详情。
- 横竖屏排版由 `services/adaptiveLayout.ts` + `readingViewport.ts` 统一计算，只读 `settings.readerPrefs` / `pdfPrefs` 生效值，不把自动值回写到保存设置。用户输入通过 `setReaderPreference` / `setPdfPreference` 标记显式选择（包括与默认值相同的选择）；手动项优先，旋转和窗口缩放不能覆盖。`layoutOverrides` 与偏好同步，旧存档按自定义值和修改记录迁移。
- 新增设置项：在 `SettingsState` + `defaults` 里加字段即可（load 时自动 merge）；改历史默认值才需递增 `SETTINGS_VERSION` 并写迁移。
- Vue 模板里 `v-for` 变量不要用 `t`（会遮蔽 i18n 函数）。
- 组件样式用 `<style scoped>`；需要覆盖主题的选择器写成 `:root[data-theme='dark'] .x`。

## 边界 / 不要做

- **e2e 依赖的选择器别改语义**：`getByRole('button', { name })`（分段控件按钮不要改成 `role="radio"`），`button[title="目录"]` 等 title 文案，`.book-card` `.booklist-action` `.booklist-chip` `.sidebar-update`（收起 ≤42px、悬停 ≥108px）、`text=书架还是空的` / `这个书单还是空的` 等文案 key。改动后跑一遍 `npm run e2e`。
- `PaperReaderView.vue` 里仍有约 70 处硬编码浅色面板；深色主题下它不是完全适配的，改动前先看那一段样式。
- Z-Library 等需要登录/验证的来源使用外部浏览器；优先接入免登录的公开搜索与下载（2026-10-03 用户要求）。不支持 KFX（见产品设计文档），不引入组件库 / Tailwind。
- 阅读正文主题 (`settings.reader.theme`) 与应用外观 (`settings.appearance`) 是两个设置项，不要把显式选择的正文主题绑到外观上；默认值 `auto` 例外，它经 `resolveReaderTheme()` 跟随外观在浅色/夜间间切换。
- 不要提交 `.env*`、`.corpus`、`dist`、`src-tauri/target`。

## 账号后端部署

- `cd sync-server && npx wrangler deploy -c wrangler.jsonc`（必须带 `-c`，否则会撞上根目录构建留下的 `.wrangler/deploy/config.json`）。用 `~/.config/tokenssh-ai/cloudflare-workers-token` 作 `CLOUDFLARE_API_TOKEN` 即可部署；它没有 D1 权限，改表结构要走 Cloudflare MCP 的 D1 query API。
- `DEV_EXPOSE_CODE` 只用于本地测试，**生产绝不能设**（否则任何人都能拿到任意邮箱的验证码）。

## 发版流程

**T9 构建优先（2026-10-23 用户要求）**：LightRead 的编译统一放在 `ssh t9` 构建机执行，包括前端构建与 Rust 编译/原生测试；当前开发机负责编辑与轻量验证。在 T9 完成构建、校验后再按授权上传 GitHub Release，以减少 Actions 用量。平台、版本、Android 固定签名、校验清单和公开门禁保持不变；Linux 本机产物不能代替 macOS / Windows 的对应构建。本地发版先设 GitHub 仓库变量 `RELEASE_BUILD_MODE=manual`，此时推送 `v*` tag 的自动构建会跳过；显式 `workflow_dispatch` 不受影响。Android 本地构建后上传到草稿，附原有 APK 校验报告和 `.apk.build.json`（`tag`、`commit`、`sha256`），再手动运行 Release（`tag=vX.Y.Z`、`full_release=true`、`reuse_android=true`）；CI 复核本地 APK 并构建桌面平台，全部门禁通过才公开。未设置该变量时保留原来的 tag 自动构建；`reuse_android=false` 保留 CI Android 构建。v1.18.1 已由 CI 完整成功发布，无需重建或覆盖。

T9 非交互 SSH 需显式加入 `~/.cargo/bin` 到 PATH；LightRead 的 Rust 缓存使用 `~/tokenssh-build/cache/lightread-cargo-target`，源码在 `~/tokenssh-build/runs/` 下建独立目录。重任务在 T9 使用 `flock /tmp/heavy.lock nice -n 10 ...` 串行执行。不要同步本机 `node_modules`、`target`、密钥或无关草稿；桌面前端构建设置 `TAURI_ENV_PLATFORM=linux`。T9 已配置 GTK 3、WebKitGTK 4.1 与 Xvfb（2026-10-23）；无显示器的桌面启动与拖放验证可用 `xvfb-run`。

1. 发版前检查工作区、需求清单与变更范围；同步修改 `package.json`、`package-lock.json`（顶层和根包两处）、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（lightread 包）、`src-tauri/tauri.conf.json`。执行 `node scripts/check-release.mjs --self-test` 和 `node scripts/check-release.mjs --tag vX.Y.Z`，版本或 tag 不一致即停止。
2. 完成相关单测、`npm run build`、阅读器/更新流程冒烟；Rust 变更执行相应原生测试。桌面分别确认 macOS arm64/x64、Windows NSIS、Linux AppImage/deb 的目标平台。CI 的 Rust 最低版本检查也必须通过。资源密集任务使用 `flock /tmp/heavy.lock nice -n 10 ...` 串行执行。
3. Android 仍为**实验性 arm64 debug 包**，既有应用身份是 `com.yzfly.lightread.debug`；不能直接去掉 `.debug`、改用 release 构建或替换证书来“修复”覆盖升级。CI 保留 `--debug`，要求仓库 secret `ANDROID_KEYSTORE_B64` 和非秘密仓库变量 `ANDROID_CERT_SHA256`（64 位十六进制、对应同一固定证书）。密钥须兼容现有 Android debug signing 配置（别名 `androiddebugkey`，store/key password 均为 `android`），受控备份；禁止提交密钥、打印 secret 或临时生成签名兜底。缺配置必须失败。
4. **历史签名迁移限制（2026-10-03 核实）**：此前 CI 缺少固定签名 secret，使用 runner 临时密钥。官方 v1.3.0 APK 与 v1.1.18 安装的证书不同，因此无法承诺跨这些版本覆盖升级；公开证书指纹不能恢复私钥。v1.4.0 起专用固定密钥位于 `~/.config/lightread/signing/lightread-android.jks`，本机备份位于 `~/.local/share/lightread/signing-backup/lightread-android.jks`，GitHub secret 已配置。异地备份在 R2 私有桶 `yzfly-signing-backup/lightread/lightread-android.jks`（不加密、不设额外口令，靠 Cloudflare 账号权限保护；恢复方法见同目录 README.txt，2026-10-04 用户选定）。公开证书 SHA256 为 `56103db2e518cf800db66d148d45f886e93c12b1afc8944ec668713636c7bada`。不要覆盖这两个密钥文件或复用其他项目签名。历史用户迁移按 README 的 Android 备份/恢复说明执行；不得默默卸载旧应用、清空数据或声称新固定签名可覆盖所有旧随机签名安装。
5. **本地 Android 打包只用 `npm run android:build`**（`scripts/build-android.mjs`），不要手敲 `tauri android build`。它固定 `CARGO_PROFILE_DEV_DEBUG=0`（`--debug` 走 Cargo dev profile，默认带完整 DWARF；app-v2.1.1 首次本地打包就因此从 94MB 涨到 284MB），先 `:app:clean` 避免增量 ZIP 留下整份旧原生库的空洞，并要求固定签名。`check-release.mjs` 的 ZIP 布局与原生库校验（`.so` 不得含 `.debug_*` 段）必须通过，不能只检查包名与签名。对候选 APK 执行 `node scripts/check-release.mjs --tag vX.Y.Z --apk <APK路径> --cert <固定证书SHA256>`（`aapt`/`apksigner` 在 PATH 或通过 `AAPT`/`APKSIGNER` 指定）。校验实际包名、versionName、versionCode、仅 arm64-v8a、minSdk 24、targetSdk 36、签名证书；生成 `.apk.json` 报告与 `.apk.sha256`。API 基线升级必须显式审查并更新检查脚本。真机记录 Android API、ABI、WebView 版本；用相同固定签名的前一版本执行覆盖升级，验证藏书/阅读进度/设置保留、离线启动、导入和阅读，以及点开下载→返回应用→版本检查。签名不一致时只做经授权的数据迁移，不能以卸载重装充当覆盖升级验收。
6. 提交信息使用 `release: vX.Y.Z`，正文写用户可见变化、修复、验证与已知限制，作为 GitHub Release 说明。按需检查 `gh auth status`，推送使用 yzfly 账号。发版工作获得授权后才创建并推送 annotated tag：`git tag -a vX.Y.Z -m "vX.Y.Z"`、`git push origin main vX.Y.Z`；只有整理发版规范的任务不执行推送/发布。
7. `.github/workflows/release.yml` 先校验版本/tag/签名配置，再构建各平台并上传 **draft Release**。Android 失败不再忽略；APK 必须完成上述静态检查后才能上传。最终 job 下载资产核对 APK SHA256、检查平台安装包齐全，生成并回验 `SHA256SUMS` 后才公开 Release。任一环节失败保留草稿，排查并重跑；不要手动提前公开不完整草稿。
8. 公开后核对 Release 下载链接、版本说明、APK 报告、SHA256SUMS 和各平台更新入口；记录实机验收结果与已知限制。`workflow_dispatch` 指定 `tag` 时默认仅替换该 tag 的 Android 资产并重算校验清单，不改变现有 Release 的公开状态。恢复失败草稿时可再指定 `full_release=true`，使用当前 workflow 完整构建目标 tag，全部平台通过后公开；不得移动已有 tag 或对公开版本执行完整覆盖。所有安装包从指定 tag 源码构建，保持包名/签名/版本一致。审核脚本从本次 workflow 的固定 SHA 提取并保存在 `RUNNER_TEMP`，随后检出目标 tag 审核和构建；旧 tag 无需包含新版脚本，但仍须通过当前身份、签名与版本门禁。
9. Android CI 必须通过 `LIGHTREAD_ANDROID_KEYSTORE` 显式绑定 Gradle debug signingConfig；仅写 `~/.android/debug.keystore` 在 runner 上不保证被使用。构建前用 keytool 导出的公开证书核对固定 SHA256，构建后用 apksigner 再核对实际 APK；两者均通过才能上传。临时密钥只放 `RUNNER_TEMP`，job 结束清理。本机已用该显式配置重打 v1.4.0 并通过完整 APK 校验。
10. **GitCode 国内镜像**：`publish` 成功后，`mirror-gitcode` job（调用 `.github/workflows/mirror-gitcode.yml` 和 `scripts/mirror-gitcode.mjs`）只读取已公开的 GitHub Release，把它同步到 GitCode，逐个回下载校验 SHA-256，最后上传 `SHA256SUMS`。未配置 secret `GITCODE_TOKEN` 时自动跳过；镜像失败不影响 GitHub Release，修好后手动运行该 workflow 补跑（`tag=vX.Y.Z`，补跑是幂等的）。不要让镜像 job 反过来成为 `publish` 的前置条件。应用内更新器只采用带 `SHA256SUMS` 的镜像版本，镜像下载必须通过校验。设置与运维见 `docs/gitcode-mirror.md`。镜像仓库是 GitCode 上的 **`langgpt/LightRead`**（GitCode 没有 yzfly 用户；应用内 `MIRROR_REPO` 与离线语音包镜像地址都指向它）。**CI 未配置 `GITCODE_TOKEN` 时，发版公开后在本机运行 `scripts/mirror-gitcode-cli.sh vX.Y.Z`**（用本机已登录的 GitCode CLI `~/.local/bin/gitcode`，幂等、逐个回下载校验、SHA256SUMS 最后上传；**GitCode 只留最新版**，镜像成功后脚本尝试删除更旧的版本，离线语音包 `tts-models` 保留；GitCode API 不支持删除 Release，删不掉的会列出来，需在网页手动删）。**GitHub 只留稳定版**（2026-10-05 用户定）：最新版 + 各小版本的最后一版，其余 Release 删除，git tag 保留。
