@echo off
cd /d "%~dp0"
title citystate - tauri dev
set "PATH=%ProgramFiles%\nodejs;%USERPROFILE%\.cargo\bin;%APPDATA%\npm;%PATH%"
where npm.cmd >nul 2>nul || (echo [ERROR] npm not found. Install Node.js first. & pause & exit /b 1)
where cargo >nul 2>nul || (echo [ERROR] cargo not found. Tauri needs Rust: https://rustup.rs & pause & exit /b 1)
node -v
cargo -V
if not exist "node_modules\@tauri-apps\cli" call npm.cmd install
echo Starting Tauri dev. First Rust build can take several minutes...
powershell -NoProfile -ExecutionPolicy Bypass -Command "& npm.cmd run tauri:dev 2>&1 | Tee-Object -FilePath tauri-dev.log"
pause
