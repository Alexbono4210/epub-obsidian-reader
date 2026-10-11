@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "release\页间\页间 V0.2.exe" (
  echo 尚未生成便携版。请先安装 Node.js 22.12 或更新版本。
  echo 在本文件夹打开终端，依次运行 npm ci 和 npm run package。
  echo 也可以运行 npm ci 后用 npm start 直接启动源码。
  pause
  exit /b 1
)
start "" "release\页间\页间 V0.2.exe"
