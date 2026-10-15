@echo off
rem Builds a single ScreenLock.exe (no Python needed to run it). Run from this folder.
py -m pip install -r requirements.txt pyinstaller || exit /b 1
py -m PyInstaller --noconsole --onefile --name ScreenLock run_screenlock.pyw || exit /b 1
echo.
echo Done. Your program is dist\ScreenLock.exe
