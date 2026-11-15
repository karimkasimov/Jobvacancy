@echo off
setlocal EnableExtensions
chcp 65001 >nul
title ГГКИТ Карьера ЧР — запуск сайта

rem Переходим в корень проекта независимо от того, откуда запущен BAT-файл.
cd /d "%~dp0"
if errorlevel 1 (
    echo [ОШИБКА] Не удалось открыть папку проекта.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo                 ГГКИТ Карьера ЧР
echo                    Запуск сайта
echo ============================================================
echo.

rem Проверяем обязательные файлы проекта.
if not exist "package.json" (
    echo [ОШИБКА] Не найден package.json. START.bat должен находиться в корне проекта.
    goto :failed
)
if not exist "server\index.js" (
    echo [ОШИБКА] Не найден server\index.js.
    goto :failed
)
if not exist "server\app.js" (
    echo [ОШИБКА] Не найден server\app.js.
    goto :failed
)
if not exist "server\config.js" (
    echo [ОШИБКА] Не найден server\config.js.
    goto :failed
)
if not exist "migrations\001_init.sql" (
    echo [ОШИБКА] Не найдена начальная миграция migrations\001_init.sql.
    goto :failed
)
if not exist "public\index.html" (
    echo [ОШИБКА] Не найдена главная страница public\index.html.
    goto :failed
)
if not exist "public\css\style.css" (
    echo [ОШИБКА] Не найден файл public\css\style.css.
    goto :failed
)
if not exist "public\css\app.css" (
    echo [ОШИБКА] Не найден файл public\css\app.css.
    goto :failed
)
if not exist "public\js\pages\home.js" (
    echo [ОШИБКА] Не найден файл public\js\pages\home.js.
    goto :failed
)
if not exist ".env.example" (
    echo [ОШИБКА] Не найден файл .env.example.
    goto :failed
)

echo [OK] Файлы проекта найдены.

rem Проверяем Node.js и минимальную версию из package.json: 22.13.0.
where node >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден.
    echo Установите Node.js версии 22.13.0 или новее, затем перезапустите START.bat.
    echo Скачать: https://nodejs.org/
    goto :failed
)

for /f "delims=" %%V in ('node --version 2^>nul') do set "NODE_VERSION=%%V"
if not defined NODE_VERSION (
    echo [ОШИБКА] Не удалось определить версию Node.js.
    goto :failed
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Установлен Node.js %NODE_VERSION%, а требуется версия 22.13.0 или новее.
    echo Обновите Node.js: https://nodejs.org/
    goto :failed
)
echo [OK] Node.js %NODE_VERSION% подходит.

where npm >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Команда npm не найдена. Переустановите Node.js с npm.
    goto :failed
)
echo [OK] npm найден.

echo.
echo Сервер запускается командой npm start.
echo Браузер откроется автоматически после ответа сервера.
echo Для остановки сервера нажмите Ctrl+C.
echo.

rem Ожидаем реального HTTP-ответа, а не используем фиксированную задержку.
rem Порт берётся из .env (если он задан), иначе используется 3000.
start "" /b powershell.exe -NoLogo -NoProfile -Command "$port=3000; if (Test-Path -LiteralPath '.env') { $entry=Get-Content -LiteralPath '.env' | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -Last 1; if ($entry) { $candidate=($entry -split '=',2)[1].Trim().Trim([char]34).Trim([char]39); if ($candidate -match '^\s*(\d+)') { $port=[int]$Matches[1] } } }; if ($env:PORT) { if ($env:PORT -match '^\s*(\d+)') { $port=[int]$Matches[1] } else { $port=3000 } }; $url='http://localhost:' + $port; $probe='http://127.0.0.1:' + $port + '/'; $deadline=(Get-Date).AddSeconds(60); while ((Get-Date) -lt $deadline) { try { $response=Invoke-WebRequest -Uri $probe -Method Get -TimeoutSec 2 -UseBasicParsing; if ($response.StatusCode -eq 200) { Write-Host ('[OK] Сайт доступен: ' + $url); Start-Process $url; exit 0 } } catch { }; Start-Sleep -Milliseconds 500 }; Write-Host '[ОШИБКА] Сервер не ответил за 60 секунд. Проверьте сообщения npm start и порт в файле .env.'"

call npm start
set "SERVER_EXIT_CODE=%ERRORLEVEL%"
echo.
echo Сервер остановлен (код завершения: %SERVER_EXIT_CODE%).
echo Сообщения об ошибках, если они были, указаны выше.
pause
exit /b %SERVER_EXIT_CODE%

:failed
echo.
echo Запуск отменён. Исправьте указанную проблему и запустите START.bat снова.
pause
exit /b 1
