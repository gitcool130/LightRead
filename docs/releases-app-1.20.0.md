# v1.20.0

App 1.x 最终版，沿用 v1.19.4 功能和界面；仅 App 版本推进到 1.20.0。桌面代码与基础版本保持 1.19.4。Android / iOS 版本由各自 Tauri 平台配置覆盖，前端按原生目标显示对应版本。

Android 清理打包输出后从本标签重新构建，避免增量 ZIP 留下大块无效填充。沿用 `com.yzfly.lightread.debug`、arm64 debug、原固定签名、minSdk 24 和 targetSdk 36；不清空用户数据。

发版用 `Release App` 工作流校验本地候选 APK：源码提交、平台版本、签名、ABI、ZIP 空洞和全部 SHA256 必须通过才公开。Release 标题只写 `v1.20.0`。这是仅包含 App 资产的版本，`latest=false` 避免旧桌面更新器收到没有桌面安装包的版本；桌面 latest 保持 v1.19.4。后续 App 2.0 发布前需完成独立 App 更新通道。
