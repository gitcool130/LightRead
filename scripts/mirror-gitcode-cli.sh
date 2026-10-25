#!/usr/bin/env bash
# 用本机已登录的 GitCode CLI 把已公开的 GitHub Release 镜像到 GitCode (langgpt/LightRead)。
# CI 的 mirror-gitcode job 需要 GITCODE_TOKEN; 没配时发版后在本机跑这个脚本 (幂等, 可重复执行)。
#
#   scripts/mirror-gitcode-cli.sh v1.8.1
#
# 流程: 下载 GitHub Release 并按 SHA256SUMS 校验 → GitCode 上没有该 Release 就创建 (说明末尾附各文件大小,
# 应用内更新靠它显示大小) → 小文件先传, 已存在且校验一致的跳过 → 每个文件从公开地址下载回来比对 SHA-256
# → 最后上传 SHA256SUMS (应用只认带 SHA256SUMS 的镜像版本) → 删除 GitCode 上的其他版本 (只留最新版)。
# CLI 自带的 upload 有 30 秒超时, 大文件传不完: 这里用 CLI 取预签名上传地址, 再用 curl 直传。
set -euo pipefail

TAG=${1:?用法: mirror-gitcode-cli.sh vX.Y.Z}
GH_REPO=${GH_REPO:-yzfly/LightRead}
GC_REPO=${GITCODE_REPO:-langgpt/LightRead}
GC=${GITCODE_CLI:-$HOME/.local/bin/gitcode}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

public_url() { echo "https://gitcode.com/$GC_REPO/releases/download/$TAG/$1"; }
remote_sha() { curl -sSLf --retry 5 --retry-all-errors "$(public_url "$1")" | sha256sum | cut -d' ' -f1; }

upload() {
  local file=$1 name want json url code
  name=$(basename "$file")
  want=$(sha256sum "$file" | cut -d' ' -f1)
  for attempt in 1 2 3 4 5; do
    json=$("$GC" api "repos/$GC_REPO/releases/$TAG/upload_url?file_name=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$name")" --no-interactive)
    url=$(printf '%s' "$json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["url"])')
    mapfile -t hdrs < <(printf '%s' "$json" | python3 -c 'import sys,json
for k,v in json.load(sys.stdin)["headers"].items(): print(f"-H\n{k}: {v}")')
    code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "${hdrs[@]}" --upload-file "$file" "$url" || echo 000)
    if [[ $code == 2* && $(remote_sha "$name" || true) == "$want" ]]; then
      echo "  ✓ $name"
      return 0
    fi
    echo "  … $name 第 $attempt 次未成功 (HTTP $code), 重试" >&2
    sleep $((attempt * 10))
  done
  echo "  ✗ $name 上传失败" >&2
  return 1
}

"$GC" auth status >/dev/null 2>&1 || { echo "GitCode CLI 未登录: 先运行 gitcode auth login" >&2; exit 1; }

# 版本 tag 必须先以原提交推到 GitCode；不能由 release create 在 GitCode 默认分支上隐式生成同名 tag。
# 只使用已经同步且与 GitHub 相同的 tag；不移动已有 tag。
TARGET_REF=main
if [[ $TAG =~ ^(app-)?v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  TARGET_REF=$(node --input-type=module - "$GH_REPO" "$GC_REPO" "$TAG" <<'JS'
import assert from 'node:assert/strict';
import { remoteTagCommit } from './scripts/mirror-gitcode.mjs';
const [github, gitcode, tag] = process.argv.slice(2);
const expected = remoteTagCommit(`https://github.com/${github}.git`, tag);
const actual = remoteTagCommit(`https://gitcode.com/${gitcode}.git`, tag);
assert.ok(expected, `GitHub tag ${tag} 不存在`);
assert.ok(actual, `请先将 ${tag} 同步到 GitCode，不能从 main 创建版本 tag`);
assert.equal(actual, expected, 'GitCode tag 与 GitHub 提交不一致');
console.log(actual);
JS
  )
fi

echo "下载 GitHub Release $TAG …"
gh release download "$TAG" -R "$GH_REPO" -D "$WORK/assets"
(cd "$WORK/assets" && sha256sum -c --quiet SHA256SUMS)

if ! "$GC" release view "$TAG" -R "$GC_REPO" >/dev/null 2>&1; then
  echo "在 GitCode 创建 Release $TAG …"
  gh release view "$TAG" -R "$GH_REPO" --json name,body > "$WORK/release.json"
  python3 - "$WORK" <<'EOF'
import json, os, sys
work = sys.argv[1]
rel = json.load(open(f"{work}/release.json", encoding="utf-8"))
d = f"{work}/assets"
sizes = {f: os.path.getsize(f"{d}/{f}") for f in sorted(os.listdir(d)) if f != "SHA256SUMS"}
body = (rel.get("body") or "").strip()
open(f"{work}/notes.md", "w", encoding="utf-8").write(
    f"{body}\n\n<!-- lightread-mirror-sizes {json.dumps(sizes, separators=(',', ':'))} -->\n")
open(f"{work}/title", "w", encoding="utf-8").write(rel.get("name") or "")
EOF
  "$GC" release create "$TAG" -R "$GC_REPO" --target "$TARGET_REF" -t "$(cat "$WORK/title")" -F "$WORK/notes.md" --no-interactive >/dev/null
fi

existing=$("$GC" api "repos/$GC_REPO/releases/tags/$TAG" --no-interactive | python3 -c 'import sys,json
for a in json.load(sys.stdin).get("assets") or []:
    if a.get("type") != "source": print(a["name"])')

echo "上传并校验安装包 …"
while read -r name; do
  [[ $name == SHA256SUMS ]] && continue
  file="$WORK/assets/$name"
  if grep -qxF "$name" <<<"$existing" && [[ $(remote_sha "$name" || true) == $(sha256sum "$file" | cut -d' ' -f1) ]]; then
    echo "  = $name (已存在且一致)"
    continue
  fi
  upload "$file"
done < <(cd "$WORK/assets" && ls -S -r)

if grep -qxF SHA256SUMS <<<"$existing" && [[ $(remote_sha SHA256SUMS || true) == $(sha256sum "$WORK/assets/SHA256SUMS" | cut -d' ' -f1) ]]; then
  echo "  = SHA256SUMS (已存在且一致)"
else
  upload "$WORK/assets/SHA256SUMS"
fi
# GitCode 上每条发版线只留最新版: 桌面 vX.Y.Z 与 App app-vX.Y.Z 分开计算 (2026-10-25 起两条线分开发版)。
# 本版本完整镜像并校验后, 只删除同一条线上比它旧的 Release; 离线语音包 tts-models 不是版本号, 保留。KEEP_OLD=1 时跳过。
if [[ ${KEEP_OLD:-0} != 1 && $TAG =~ ^(app-)?v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  old=$("$GC" api "repos/$GC_REPO/releases?per_page=100" --no-interactive | python3 -c 'import sys,json,re
cur = sys.argv[1]
prefix = cur[:cur.index("v") + 1]
v = lambda x: tuple(int(n) for n in x[len(prefix):].split("."))
for r in json.load(sys.stdin):
    t = r.get("tag_name", "")
    if re.fullmatch(re.escape(prefix) + r"\d+\.\d+\.\d+", t) and v(t) < v(cur): print(t)' "$TAG")
  # GitCode API 不支持删除 Release (HTTP 405, 2026-10-05 实测), 删不掉时只提醒去网页删除, 不让镜像失败。
  for t in $old; do
    if "$GC" release delete "$t" -R "$GC_REPO" --yes --no-interactive >/dev/null 2>&1; then
      echo "  - 已删除旧版本 $t"
    else
      echo "  ! 旧版本 $t 需在网页手动删除: https://gitcode.com/$GC_REPO/releases"
    fi
  done
fi
echo "完成: https://gitcode.com/$GC_REPO/releases"
