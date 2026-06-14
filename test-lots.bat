@echo off
chcp 1251 >nul
setlocal

REM ============================================================
REM  PigRating - ������� �������� ����� � pointauc (��� �������� ����������)
REM
REM  �����: ����� ���� ���� � ��������� Windows-1251 (ANSI / ���������).
REM         ���� ������������� � UTF-8 - ��������� ���������.
REM
REM  ��� ������������:
REM   1) ������ ���� ����� � ������ TOKEN ����
REM      (pointauc.com -> ��������� -> Personal Token).
REM   2) � ����� "������ �����" ��������� ������ ����:
REM         call :add "�������� ����"  "���_���������"  �����
REM      ����-�����:
REM       - ���� � ��� �� ��� � ������� ������   = ��������� ���������� (��������� ���)
REM       - ���� � ��� �� ��� � ������ �����      = ��� � ���������� �����
REM       - ���, �������� ����� ���              = � ���������� "������� ��� / ��� ����"
REM   3) ������� ���� � ������� ������� ������.
REM
REM  ������ ��� ��������: ����� REM � ������ "set DRYRUN=1".
REM  ����� ����� - ���������. ���� = ���� �� ������� (twitch-������).
REM ============================================================

set "TOKEN=������_����_�����"
REM set "DRYRUN=1"

REM =================== ������ ����� ===========================
call :add "Half-Life 2"    "2BeFirefly"    800
call :add "INSIDE"         "maxxsxsx"      200
call :add "Mass Effect 2"  "ffirinor"      600
call :add "Mass Effect 2"  "vova_ova1"     200
call :add "Diablo 3"       "oridontworry"  300
call :add "Outlast"        "oridontworry"  150
REM =================== ����� ������ ===========================

del "%TEMP%\pa_bid.json" 2>nul
echo.
echo ������. ������ pointauc � ������� �����.
pause
exit /b

:add
set "LOT=%~1"
set "INV=%~2"
set "PTS=%~3"
> "%TEMP%\pa_bid.json" echo {"bids":[{"cost":%PTS%,"message":"%LOT%","investorId":"%INV%","username":"%INV%","insertStrategy":"force","isDonation":false}]}
if defined DRYRUN (
  echo [dry] %LOT% / %INV% / %PTS%
  type "%TEMP%\pa_bid.json"
  echo.
  goto :eof
)
echo %TOKEN%| findstr /c:"-" >nul || (
  echo [!] ������� ����� ���� ����� � ������ TOKEN ������ �����.
  goto :eof
)
curl -s -o nul -w "  [%%{http_code}] %LOT% / %INV% : %PTS%\n" -X POST -H "Authorization: Bearer %TOKEN%" -H "Content-Type: application/json" --data-binary "@%TEMP%\pa_bid.json" "https://pointauc.com/api/oshino/bids"
goto :eof
