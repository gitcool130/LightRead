# GitCode 国内镜像

GitHub Release 公开后，自动把同一版本的全部安装包同步到 GitCode（`https://gitcode.com/langgpt/LightRead/releases`），给中国大陆用户提供更快的下载源。选择 GitCode 的原因见 `docs/research/cn-hosting-and-cosyvoice3.md` §A。

**在负责人完成下面的「一次性设置」之前，这套机制不会做任何事。** 发版流程照常进行，镜像 job 会直接跳过；应用内更新器尝试 GitCode 失败后，会继续按原来的方式使用 GitHub。

## 工作方式

- **CI**：`release.yml` 的 `publish` 成功后，`mirror-gitcode` job 调用 `.github/workflows/mirror-gitcode.yml`，由 `scripts/mirror-gitcode.mjs` 完成以下步骤：
  1. 下载已公开的 GitHub Release，用 `sha256sum -c SHA256SUMS` 校验；草稿不镜像。
  2. 确保 GitCode 上有同名 tag，并且指向同一个提交。tag 已存在就直接核对；不存在就用令牌通过 HTTPS 推送；推送被拒绝时（仓库设成了 pull 镜像），最多等 10 分钟，等镜像把 tag 同步过来。如果提交不一致，立即失败。
  3. 幂等地创建或更新 GitCode Release，标题和说明与 GitHub 一致。说明末尾会附一段 HTML 注释，记录各文件大小（GitCode API 不返回文件大小，应用里要靠它显示大小）。
  4. 补传 GitCode 上缺少的文件，小文件先传。每个文件最多尝试 5 次，退避间隔 5/15/45/90 秒，每次重试都重新获取 `upload_url`。
  5. 从公开地址匿名 GET 下载每个文件（GitCode 对 HEAD 请求返回 401，所以不用 HEAD），比对 SHA-256。不一致的文件删掉重传，再校验一遍。
  6. **最后**上传 `SHA256SUMS` 并校验。因此 GitCode 上出现 `SHA256SUMS`，就说明这个版本的镜像已经完整并且校验通过。
- **镜像失败不影响 GitHub Release**：镜像 job 在 GitHub Release 公开之后才开始，对 GitHub 只读。失败时 Actions 会显示红色，step summary 里写明 GitHub Release 不受影响；修好后手动补跑即可，补跑是幂等的。
- **Android 修补**（`release.yml` 指定 `tag`，只替换 APK）：如果 `SHA256SUMS` 有变化，先删除 GitCode 上旧的清单，再重传有变化的 APK，最后上传新清单。
- **应用内更新**（`src/services/updater.ts`）的回退顺序：
  1. 先请求 GitHub，8 秒内没有结果就改用 GitCode；
  2. GitCode 也失败（例如镜像还没开通），再请求一次 GitHub，等待时间与以前相同（30 秒）。

  具体规则：
  - **只采用带 `SHA256SUMS` 的 GitCode 版本**。仍然比较版本号，按平台挑选安装包，下载地址统一拼成 `https://gitcode.com/langgpt/LightRead/releases/download/<tag>/<文件名>`。
  - **应用内下载**：8 秒内连不上，或下载中途 15 秒没有新数据，就换下一个源。国内常见 GitHub「连得上但只有几十 KB/s」，所以第一次 GitHub 下载开始 10 秒后平均速度不到 256 KB/s 也换 GitCode（之后的 GitCode 和耐心重试不限速度）。最近一次检查更新只能靠 GitCode 完成时，下载和校验清单都先走 GitCode。
  - **安卓应用**：不再跳到浏览器，在应用里下载 APK。下载由 Rust 流式写入应用缓存 `cache/updates/`（`src-tauri/src/app_update.rs`），同样按上面的顺序换源、按 `SHA256SUMS` 校验；校验通过才改名为 `.apk`，再由 `MainActivity` 的 `window.LightReadUpdater` 经 FileProvider 拉起系统安装器。没开「安装未知应用」时提示「需要允许轻阅安装应用」并给「去开启」，从设置页回来（30 分钟内）自动接着安装。清单里的 `REQUEST_INSTALL_PACKAGES` 由 `scripts/patch-android-project.mjs` 在 `tauri android init` 之后补上（CI 的「写入 MainActivity」一步会运行它）。已装上的安装包在下次启动时删除。
  - **网页版**（手机浏览器 / PWA）：点安装包链接时先打开空白页，再用 3.5 秒探测 GitHub；连得上就用 GitHub，慢或不通就打开 GitCode 上的同一个文件。
  - **校验**：从 GitCode 下载的文件必须通过 `SHA256SUMS` 校验，优先用 GitHub 上的清单，取不到时才用 GitCode 上的；取不到清单就拒绝安装。从 GitHub 直接下载时，能取到清单就校验，取不到就照旧安装。
  - 如果最近一次检查更新只能靠 GitCode 完成，「发布页」「下载」链接会改为打开 GitCode。

## 本机用 GitCode CLI 镜像（当前做法）

镜像仓库 `langgpt/LightRead` 已于 2026-10-05 用 GitCode CLI 创建（GitCode 上没有 yzfly 用户，账号是 langgpt），离线语音包 `tts-models` 和 v1.8.0 已同步。CI 没有配置 `GITCODE_TOKEN` 时，`mirror-gitcode` job 会跳过；此时在发版公开后，在已登录 CLI 的机器上运行：

```bash
scripts/mirror-gitcode-cli.sh vX.Y.Z        # 桌面
scripts/mirror-gitcode-cli.sh app-vX.Y.Z    # App
```

GitCode 上还没有该版本 tag 时，脚本先从本地仓库推送（本地 tag 必须与 GitHub 指向同一提交）。令牌取自 CLI 登录文件 `~/.config/gc/auth.json`，经临时 credential helper 交给 git，不打印、不写入 git 配置；`gitcode auth token` 要求交互确认，无法在脚本里使用。已有的 tag 不推送也不移动，只核对是否一致。

脚本是幂等的：已存在且校验一致的文件会跳过。**GitCode 上每条发版线只留最新版**：本版本全部上传并校验后，脚本会尝试删除同一条线上更旧的 Release（桌面 `vX.Y.Z` 与 App `app-vX.Y.Z` 分开计算；离线语音包 `tts-models` 保留；设 `KEEP_OLD=1` 可跳过）。GitCode API 目前不支持删除 Release（HTTP 405），脚本会列出需要手动删除的版本，到 GitCode 网页的 Releases 页面删除即可；应用内更新各取自己那条线的最新版，旧版本残留不影响更新。CLI 自带的 `release upload` 有 30 秒超时，传不完大文件，所以脚本用 CLI 获取预签名上传地址，再用 curl 直传。

## 负责人一次性设置（让 CI 自动镜像，可选）

1. **注册 GitCode**：在 <https://gitcode.com> 用手机号和邮箱注册，用户名最好用 `yzfly`。
2. **创建仓库**：新建**公开**仓库（已建好：`langgpt/LightRead`），tag 的来源二选一：
   - **推荐：推送模式**。新建仓库时勾选「使用 README 初始化」，这样仓库有默认分支，`tts-models` Release 会建在默认分支上。之后由 workflow 在每次发版时把 `vX.Y.Z` tag 连同对应提交推送过去。
   - **也可以用 pull 镜像**：在「项目设置 → 仓库镜像」里设置从 `https://github.com/yzfly/LightRead.git` 拉取。workflow 推送 tag 被拒绝后，最多等 10 分钟让镜像同步。如果同步周期更长，可以在 GitCode 上手动点一次「立即同步」，然后补跑镜像。
3. **创建访问令牌（PAT）**：在「个人设置 → 访问令牌」中新建，勾选仓库读写（含 Release）权限，设置有效期，**并记下过期日期**。
4. **把令牌存进 GitHub**。先确认当前 gh 账号是 yzfly（`gh auth status`），然后执行：

   ```bash
   gh secret set GITCODE_TOKEN -R yzfly/LightRead          # 按提示粘贴令牌，不会回显
   # 可选：GitCode 仓库路径不是默认的 langgpt/LightRead 时
   gh variable set GITCODE_REPO -R yzfly/LightRead -b langgpt/LightRead
   # 可选：GitCode 用户名与仓库 owner 不同时（推送 tag 时用作 HTTPS 用户名）
   gh variable set GITCODE_USER -R yzfly/LightRead -b <GitCode 用户名>
   ```

   如果改了 `GITCODE_REPO`，`src/services/updater.ts` 里的 `MIRROR_REPO` 也要一起改，并且下个版本才会生效。

5. **补镜像当前版本，并镜像离线语音包**（各运行一次）：

   ```bash
   gh workflow run mirror-gitcode.yml -R yzfly/LightRead -f tag=v1.8.0
   gh workflow run mirror-gitcode.yml -R yzfly/LightRead -f mirror_tts_models=true
   gh run list -R yzfly/LightRead -w mirror-gitcode.yml -L 2   # 查看结果
   ```

   `mirror_tts_models=true` 会从 `k2-fsa/sherpa-onnx` 下载 `kokoro-multi-lang-v1_1.tar.bz2`，核对大小（364816464 字节）和 SHA-256（`a3f4c73d…87dbad`），然后放到 GitCode 的 `tts-models` Release 里。离线语音包下载失败时，会退到这个地址。
6. **在大陆网络下验收**：打开 <https://gitcode.com/langgpt/LightRead/releases>，下载一个安装包测速。然后在应用的设置页点「检查更新」。

完成后，以后每次发版都会自动镜像，不用再手动操作。

## 日常维护

- **令牌过期**：镜像 job 会失败，GitHub Release 不受影响。换一个新令牌，重新执行 `gh secret set GITCODE_TOKEN`，再按第 5 步补跑缺失的版本。
- **补跑和排查**：在 Actions → *Mirror to GitCode* 中填入 tag 后运行。在本地预演不会写入任何东西：

  ```bash
  node scripts/mirror-gitcode.mjs --self-test     # 用本地假 GitCode 服务和 bare 仓库跑完整流程
  node scripts/mirror-gitcode.mjs release --repo langgpt/LightRead --tag vX.Y.Z --dir <含 SHA256SUMS 的目录> \
    --title "LightRead 轻阅 vX.Y.Z" --commit "$(git rev-parse 'vX.Y.Z^{commit}')" --dry-run
  ```

- **暂停镜像**：执行 `gh secret delete GITCODE_TOKEN -R yzfly/LightRead`。应用端会自动回到只用 GitHub。

## 尚未实测的点

- 用 PAT 通过 HTTPS 推送时，用户名填什么格式还没有验证。脚本用的是 `GITCODE_USER`，没设置时用仓库 owner。如果首次推送失败，可以改设 `GITCODE_USER`，或者改用 pull 镜像。
- 同名文件上传时 GitCode 会不会直接覆盖，也没有验证。脚本的做法是校验不一致就先删除再上传，不依赖覆盖行为。
- 大陆网络下的下载速度，以及 GitCode 条款里「游客不能下载」与实际允许匿名下载不一致的风险，见调研文档。
