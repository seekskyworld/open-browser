@echo off
setlocal
set "app=%~dp0..\..\.."
if exist "%app%\..\node\node.exe" (
  "%app%\..\node\node.exe" "%app%\skills\open-browser\scripts\bootstrap.mjs" "%app%" %*
) else (
  node "%app%\skills\open-browser\scripts\bootstrap.mjs" "%app%" %*
)
exit /b %errorlevel%
