@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo   ABS Grok - start
echo ========================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not in PATH.
    echo Install Python and enable "Add to PATH".
    pause
    exit /b 1
)

python --version
echo.

if not exist "venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv venv
    if errorlevel 1 (
        echo ERROR: Cannot create venv.
        echo Delete the venv folder and try again.
        pause
        exit /b 1
    )
)

echo Activating venv and installing dependencies...
call "venv\Scripts\activate.bat"

python -m pip install -q --upgrade pip
python -m pip install -q -r requirements.txt
if errorlevel 1 (
    echo ERROR: Cannot install requirements.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Starting ABS Grok
echo   Open browser:
echo   http://127.0.0.1:8765
echo.
echo   Stop: press Ctrl+C and wait 1-2 sec
echo ========================================
echo.

python -u abs_grok.py
set EXITCODE=%ERRORLEVEL%

echo.
echo ABS Grok finished.
pause
exit /b %EXITCODE%
