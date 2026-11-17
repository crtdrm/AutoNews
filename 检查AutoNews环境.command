#!/bin/zsh
# 显示后台运行状态，以及生成视频前还需补齐的组件。
set -eu
cd -- "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
node scripts/local-web.mjs status
node apps/cli/dist/index.js doctor || true
read -r '?按回车关闭窗口…'
