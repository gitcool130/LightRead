# 原生化 (Rust) 盘点 — 2026-10-22, v2.2.1 起

原则 (CLAUDE.md「能用 Rust 就用 Rust」): 文件读写、哈希、下载、格式解析等重活放 `src-tauri/src/`; 前端只做界面和编排。
判断标准: 书的字节是否**只为搬运**经过 WebView, 以及实测的耗时 / 内存是否落在用户能感知的路径上。
网页版没有原生层, 下列 JS 实现都保留作回退。测量方法与历史见 [perf-ledger.md](perf-ledger.md)。

## 已在 Rust (本轮新增加粗)

| 能力 | 模块 | 说明 |
|---|---|---|
| **藏书包导出 / 导入** | `backup_zip.rs` | 流式 store ZIP, 读取支持 deflate / ZIP64; 书校验 SHA-256 后直接解到书库 |
| **换书库文件夹** | `library_files.rs` `library_migrate` | `std::fs::copy`, Channel 回报进度 |
| **改名 / 文件大小** | `library_file_rename` `library_file_size` | 同步改文件名不再整本读写 |
| **上传 (同步 / 互传)** | `http_upload.rs` | 从磁盘流式上传, 显式 Content-Length, `http_upload_file` 带进度 |
| **选择文件夹扫描** | `folder_scan.rs` | 一次 IPC 递归遍历 + 大小 / 修改时间 |
| **CBR → CBZ (桌面)** | `comic.rs` | 导入时 UnRAR 原生解包一次 (顺带取封面), store CBZ 缓存在 `books/<id>.cbr.cbz`, 打开直接读缓存; 删书一并删除; 移动端 / 网页仍用 unrar wasm |
| **TXT (正文) → EPUB (桌面)** | `txt_epub.rs` | 解码 / 分章 / 段落还原 / XHTML / 打包与前端 `convertToEpub` 逐字节一致 (`testdata/txt-epub-golden.json` 10 组样本, `scripts/gen-txt-epub-golden.mjs` 重新生成); 转换一次缓存为 `<书文件>.v<版式>.epub`, 版式变化自动失效; 代码视图 TXT / Markdown / HTML 仍在前端 (marked / DOMParser) |
| **导入 EPUB 元数据 + 封面 (桌面)** | `epub_meta.rs` | 与 foliate getMetadata / 封面查找 + importer flattenMeta 一致 (`testdata/epub-meta-golden.json` 12 组, `scripts/gen-epub-meta-golden.mjs` 用 foliate 生成); 有意不复刻 foliate 对缺失封面文件返回 4 字节垃圾 Blob 的问题; 失败退回 foliate |
| **中文分词核心 cutHan (全平台, WebAssembly)** | `wasm/zh-segment` → `src/wasm/zh_segment.wasm` (26 KB) | 页面 (仿生阅读) 与重点词 Worker 同步调用, 不走 IPC; 词表代价由 JS 传入, 与 JS 逐位一致 (4.7 万段 × 3 种阈值, 及分词→新词发现→全书统计→打分整条管线), 约 2.5–3× 快; 不支持 wasm 时回退 JS (`npm run test:zh-segment-wasm`, `scripts/build-zh-segment-wasm.sh`) |
| **在线语音 Sec-MS-GEC v2** | `edge_tts.rs` + `mobile/edge_gec.rs` | 桌面与 App 共用 (v1 已被 403) |
| 指纹 / 下载 / 分块写盘 | `library_files.rs` | 同步与导入 (issue #14) |
| 更新包下载与校验 | `app_update.rs` | 流式 SHA-256 |
| 离线语音、Edge TTS、BabelDOC、Calibre、论文 Agent、字体枚举 | 各自模块 | 既有 |

## 留在 JS — 逐项证据

| 候选 | 证据 | 结论 |
|---|---|---|
| 阅读引擎 (foliate EPUB/MOBI/AZW3/FB2/CBZ, MuPDF / PDFium wasm, djvu.js) | 渲染在 WebView 内, 必须拿到字节; 原生只会多一次 IPC | 留在 JS |
| PDF 原生渲染 | 账本: 每页成本 clear ~5 ms、MuPDF run ~15 ms、putImageData ~16 ms、合成 Commit ~80 ms。原生只能替代「run」, 却要把 DPR 2 下 ~20 MB RGBA/页经 IPC 送回再 putImageData | 收益上限 <15 ms/页且很可能为负; 真正的方向是 Worker + OffscreenCanvas, 不是 Rust |
| Markdown / HTML / 代码视图 TXT → EPUB | 依赖 marked 与 DOMParser 生成良构 XHTML; 正文 TXT 已原生 (见上) | 留在 JS |
| 导入元数据 PDF | PDFium wasm 打开 69 MB / 600 页: 热 112–118 ms (首次含 wasm 初始化 ~500 ms) + 封面 6–14 ms | 不做 |
| 书源 / 链接下载 | 桌面 `fetchRemote` 已是 plugin-http (Rust reqwest); 元数据仍需字节 | 不做 |
| MOBI/AZW3 → EPUB | 依赖 foliate 的 MOBI/KF8 解析与 DOM 改写; Rust 版等于再写一套 PalmDoc/HUFF-CDIC/KF8 解码 + HTML 重写, 而阅读 MOBI 仍要 foliate; 用户主动触发, 已分片让出主线程 | 不做 |
| 重点词打分 / 新词发现 | 在 Web Worker 里后台跑 (12.1 万字全书 221 ms); 其中分词已走 wasm。打分规则仍在调 (docs/research), 两套实现逐位同步的维护成本高于收益 | 留在 JS |
| 文本分段 (splitRuns) / 阅读模式断句 | Unicode 类正则, 结果直接喂给同步渲染; 热点 cutHan 已在 wasm | 留在 JS |
| 另存为 | 复用阅读器已加载的字节 | 不做 |
| 同步合并、设置、书单等纯逻辑 | 数据量小, 有 node 契约测试 | 不做 |

## 待办 (2026-10-22 记录, 以后再做)

已做到 v2.2.4 为止; 下面这些还在 JS, 继续推进时按顺序看:

1. **重点词打分 / 新词发现 (keyWords.ts + keyWordsBook.ts + terminology.ts, 约 1,240 行) → 待用户决定**
   - A: 改成 Rust (wasm) 唯一实现, 删掉 JS; 以后调参都在 Rust 里改并重编 wasm, node 测试也跑 wasm。
   - B: 保持 JS (推荐: 已在 Worker 后台跑, 用户无感; 算法仍在调, 两套逐位同步的成本高)。
   - 若选 A: 沿用分词的做法 —— JS 的 Math.log/exp 等以 wasm import 传入保证浮点一致、按插入顺序的 Map、
     Unicode 类判断由 JS 侧或精确表给出; 用 test:key-words 语料做整条管线逐位比对后再删 JS。
2. **MOBI / AZW3 → EPUB**: 需要第二套 MOBI/KF8 解码 + HTML 重写, 结果依赖 DOM, 无法与现有输出逐文件比对; 做之前先定「允许输出不同」的验收标准。
3. **PDF 导入元数据**: 封面要用阅读器的 PDFium 渲染, 单做书名/作者省不掉 JS 那一步; 要做就连封面一起原生 (需原生 PDF 渲染库)。
4. **PDF 打开速度** (唯一实测瓶颈): 方向是 Worker + OffscreenCanvas, 不是 Rust; 原生渲染每页只能省约 15 ms 且要多一次 ~20 MB 传输。
5. **未在安装版里手动验证**: 桌面的 TXT / CBR 原生缓存、EPUB 原生导入元数据。

编译、测试、打包一律放 t9 服务器 (见 CLAUDE.md「构建机」), 不占本机。
