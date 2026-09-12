@echo off
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
python "%~dp0cloud_transfer.py" %*
exit /b %errorlevel%
