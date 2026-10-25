# App 与桌面界面的边界

桌面、默认 Web/PWA 使用 `src/` 的桌面界面，Android / iOS 使用本目录的 App 界面；两端在同一 `main` 分支开发，但分开发版（2026-10-25）：桌面 `vX.Y.Z`，App `app-vX.Y.Z`，规则见根目录 `CLAUDE.md`「分支与版本」。不是按窗口宽度切换产品；桌面缩窄窗口仍是桌面界面。

`vite.platform.ts` 在移动构建中依据 `overrides.json` 替换模块，覆盖共享模块间接导入的排版、主题、文案和语音调度。阅读引擎、存储、同步、PDF 等仍共用。不要把 App 专属修改写回对应的桌面文件。新增覆盖文件需登记清单。

- 桌面：`TAURI_ENV_PLATFORM=linux npm run build`（原生 CLI 自动设置实际平台）。
- App 预览：`TAURI_ENV_PLATFORM=android npm run build`，随后同环境启动 `vite preview`。
- 浏览器开发：`LIGHTREAD_UI=mobile npm run dev`。原生桌面平台优先于这个预览参数。
- 原生：只用 `npm run android:build`（固定签名、去调试符号），不修改应用 ID。
- 版本校验：桌面 `node scripts/check-release.mjs --platform desktop --tag vX.Y.Z`；App `--platform android --tag app-vX.Y.Z`（版本取 `src-tauri/tauri.android.conf.json`）。
- 回归：`node --test scripts/test-platform-boundary.mjs scripts/test-mobile-tts.mjs scripts/test-apk-layout.mjs`。桌面用原有 `e2e-smoke.mjs`；App 用 `e2e-v2.mjs`、`e2e-mobile.mjs`。

字体仅通过 App 的 CSS / JS 依赖打包，许可一起分发。原生在线语音的 Sec-MS-GEC v2 (`src-tauri/src/mobile/edge_gec.rs`) 桌面与 App 共用：2026-10-22 核实旧 v1 令牌已被微软端点以 403 拒绝，桌面一并改用 v2，edge-tts 许可由 `nativeLicenses` 随所有构建分发。`src-tauri/src/mobile/edge_gec.rs` 的测试可独立用 `rustc --edition 2021 --test` 运行，不需要构建桌面壳。

更新器：App 取版本最高、带 Android APK 与 `SHA256SUMS` 的 Release，兼容 `app-vX.Y.Z` 与 v2.2.0–v2.2.5 统一发版时的 `vX.Y.Z`；历史 `app-v2.0.0` 的 tag 与资产保留（该 APK 只识别 `app-v2.x`）。

PDF 双形态（原版 / 重排）只属于 App：路由经 `services/readerRoute.ts` 覆盖，阅读页与设置入口都在 `src/mobile/`；桌面使用原版 PDF 阅读器，不加入重排入口。
