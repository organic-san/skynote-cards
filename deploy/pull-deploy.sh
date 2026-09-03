#!/usr/bin/env bash
# 每次被 skynote-cards-deploy.timer 觸發時跑一次。
# 沒有新 commit 就什麼都不做；有的話才 build 加重啟。
set -euo pipefail

cd /srv/app

before=$(git rev-parse HEAD)
git fetch --quiet origin main
git merge --ff-only origin/main

after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
  exit 0
fi

echo "deploy: $before -> $after"

# npm ci 每次都會整個刪掉 node_modules 重裝，在 1GB RAM 的機器上很貴。
# 只有這次更新真的動到套件清單時才值得付這個代價。
if git diff --name-only "$before" "$after" | grep -qE '^package(-lock)?\.json$'; then
  npm ci
fi

npm run build
sudo /usr/bin/systemctl restart skynote-cards
