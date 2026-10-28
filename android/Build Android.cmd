@echo off
cd /d "%~dp0"
python scripts\build.py
if errorlevel 1 pause
