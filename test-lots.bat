@echo off
chcp 1251 >nul
setlocal

REM ============================================================
REM  PigRating - заливка ТЕСТОВЫХ лотов в pointauc (для проверки расширения)
REM
REM  ВАЖНО: храни этот файл в кодировке Windows-1251 (ANSI / Кириллица).
REM         Если пересохранить в UTF-8 - кириллица сломается.
REM
REM  КАК ПОЛЬЗОВАТЬСЯ:
REM   1) Вставь свой токен в строку TOKEN ниже
REM      (pointauc.com -> Настройки -> Personal Token).
REM      Держи вкладку аукциона ОТКРЫТОЙ при запуске (API шлёт в неё).
REM   2) В блоке "СПИСОК ЛОТОВ" перечисли строки:
REM         call :add "Название лота"  "ник"  баллы          - обычная ставка
REM         call :add "Название лота"  "ник"  баллы  don     - как донат
REM      Кейсы: один лот + разные ники = групповой лот;
REM             один ник + разные лоты  = ник в нескольких лотах;
REM             ник без лота            = в расширении "выбрать лот".
REM   3) Сохрани файл и запусти двойным кликом (201 = успех).
REM
REM  Превью без отправки: убери REM в строке "set DRYRUN=1".
REM  Имена лотов - латиницей. Ники = ники из таблицы (twitch-логины).
REM ============================================================

set "TOKEN=PASTE_TOKEN_HERE"
REM set "DRYRUN=1"

REM =================== СПИСОК ЛОТОВ ===========================
call :add "Half-Life 2"    "2BeFirefly"    800 don
call :add "INSIDE"         "maxxsxsx"      200 don
call :add "Mass Effect 2"  "ffirinor"      600 don
call :add "Mass Effect 2"  "vova_ova1"     200 don
call :add "Diablo 3"       "oridontworry"  300 don
call :add "Outlast"        "oridontworry"  150 don
call :add "Cyberpunk 2077" "xalreen"       500 don
call :add "Elden Ring"     "Pajamic"       300 don
REM =================== КОНЕЦ СПИСКА ===========================

del "%TEMP%\pa_bid.json" 2>nul
echo.
echo Готово. Открой pointauc и проверь доску.
pause
exit /b

:add
set "LOT=%~1"
set "INV=%~2"
set "PTS=%~3"
set "DON=true"
if /i "%~4"=="don" set "DON=true"
> "%TEMP%\pa_bid.json" echo {"bids":[{"cost":%PTS%,"message":"%LOT%","investorId":"%INV%","username":"%INV%","insertStrategy":"force","isDonation":%DON%}]}
if defined DRYRUN (
  echo [dry] %LOT% / %INV% / %PTS% / don=%DON%
  type "%TEMP%\pa_bid.json"
  echo.
  goto :eof
)
echo %TOKEN%| findstr /c:"-" >nul || (
  echo [!] Сначала впиши свой реальный токен в строку TOKEN вверху файла.
  goto :eof
)
curl -s -o nul -w "  [%%{http_code}] %LOT% / %INV% : %PTS% (don=%DON%)\n" -X POST -H "Authorization: Bearer %TOKEN%" -H "Content-Type: application/json" --data-binary "@%TEMP%\pa_bid.json" "https://pointauc.com/api/oshino/bids"
goto :eof
