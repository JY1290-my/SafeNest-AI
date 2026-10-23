@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" "%~dp0camera_setup.py"
) else (
  python "%~dp0camera_setup.py"
)
if errorlevel 1 (
  echo Camera setup could not start. Use your existing SafeNest virtual environment.
  echo See README for the camera_setup.py launch instructions.
  pause
)
endlocal
