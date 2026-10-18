# v1.20.0

1.x 系列全平台最终版，沿用 v1.19.4 的界面和功能。Android、Windows、macOS Apple Silicon / Intel、Linux 的包内版本统一为 1.20.0。桌面不引入 App 2.0 改版；后续 App 2.0 在 `Dev` 分支开发。

Android 清理打包输出后重新构建，避免增量 ZIP 留下无效填充；APK 73,329,880 字节。沿用 `com.yzfly.lightread.debug`、arm64 debug、原固定签名、minSdk 24 和 targetSdk 36。K30 覆盖安装验证了版本、33 本真实藏书、阅读进度与设置保留；默认在线语音，既有用户保留自己的设置。

已公开的 v1.20.0 标签 `1f65e15` 不移动。其桌面基础版本原为 1.19.4；为补齐桌面安装包，构建时仅对 package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json 的六处版本元数据应用严格审计的 1.20.0 补丁。应用源码、依赖、标识和界面不改。Release 附 `desktop-version.patch`、各平台 `.build.json` 与完整 `SHA256SUMS`，可追溯原始标签、构建流程提交和补丁摘要。

桌面构建流程先保留 Actions 产物；原生包版本、平台回归、Rust 1.87 检查全部通过后才补入现有 Release 并设置 latest。复用已验证 Android 包，不重写或替换。标题只用 `v1.20.0`。

Android 仍为实验版；本版封存现有 1.x 听书实现，在线语音服务的协议兼容修复继续在 App 2.0 候选版验证，不宣称本版已解决所有语音播放失败。
