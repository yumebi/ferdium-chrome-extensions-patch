#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo " インストール済み Ferdium に Chrome拡張機能サポートを追加します..."
echo " （Ferdium が起動中の場合は先に終了してください）"
echo ""

node "$SCRIPT_DIR/apply-chrome-extensions-installed.js" "$@"
