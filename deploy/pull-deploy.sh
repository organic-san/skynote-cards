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
npm ci
npm run build
sudo /usr/bin/systemctl restart skynote-cards
