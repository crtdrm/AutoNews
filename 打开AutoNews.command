#!/bin/zsh
# 启动本地后台，并在默认浏览器中打开管理页面。
set -eu
cd -- "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
node scripts/local-web.mjs start --open
