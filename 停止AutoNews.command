#!/bin/zsh
# 只停止本项目的网页后台，保留已有数据。
set -eu
cd -- "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
node scripts/local-web.mjs stop
