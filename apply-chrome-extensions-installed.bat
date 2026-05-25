@echo off
chcp 65001 > nul
title Chrome Extensions Patch for Ferdium (インストール版)

echo.
echo  インストール済み Ferdium に Chrome拡張機能サポートを追加します...
echo  （Ferdium が起動中の場合は先に終了してください）
echo.

node "%~dp0apply-chrome-extensions-installed.js"
if %errorlevel% neq 0 (
  echo.
  echo  [ERROR] パッチの適用に失敗しました。
  echo  上のエラーメッセージを確認してください。
  echo.
  pause
  exit /b 1
)

pause
