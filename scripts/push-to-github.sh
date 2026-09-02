#!/usr/bin/env bash
# 一次性推送：token 只存在于本次进程的环境变量与命令行里，推完立刻把 remote 洗回干净地址。
#
#   GITHUB_TOKEN=ghp_xxx REPO=你的用户名/仓库名 bash scripts/push-to-github.sh
#
# 用完请去 https://github.com/settings/tokens 撤销该 token。
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GITHUB_TOKEN:?缺 GITHUB_TOKEN}"
: "${REPO:?缺 REPO，形如 yourname/intelmap}"

# 为什么先 fetch 再 push：--force-with-lease 需要一个"远端现在在哪"的基线。
# 如果先 `git remote remove`（我第一版就这么干过），追踪引用连带被删，
# lease 就没有基线可比，push 会以 "stale info" 失败。
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"

if ! git fetch -q origin; then
  echo "fetch 失败：检查 token 权限（需要该仓库的 Contents: Write）与仓库是否存在" >&2
  git remote set-url origin "https://github.com/${REPO}.git"
  exit 1
fi

behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
if [ "$behind" != "0" ]; then
  echo "远端有 $behind 个本地没有的提交，拒绝推送（先 rebase 或确认清楚再说）" >&2
  git remote set-url origin "https://github.com/${REPO}.git"
  exit 2
fi

echo "→ 推送 $(git rev-parse --short HEAD) 到 ${REPO}"
git push origin main 2>&1 | sed "s/${GITHUB_TOKEN}/***/g"

git remote set-url origin "https://github.com/${REPO}.git"
echo "→ remote 已洗成：$(git config --get remote.origin.url)"
echo "→ 现在去撤销 token：https://github.com/settings/tokens"
