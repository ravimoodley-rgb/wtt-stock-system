@echo off
title Witbank Tank Terminals - Starter
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed or not on PATH.
    echo Install it from https://nodejs.org and run this again.
    pause
    exit /b 1
)

echo Starting Witbank Tank Terminals server...
start "Witbank Tank Terminals Server" cmd /k "node server.js"

echo Waiting for server to be ready...
set /a tries=0
:wait
set /a tries+=1
if %tries% gtr 20 (
    echo Server did not start within 10 seconds.
    echo Check the server window for errors, then open http://localhost:3001 manually.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
curl -s -o nul http://localhost:3001
if errorlevel 1 goto wait

echo Server is running. Opening browser...
start "" http://localhost:3001
exit /b 0