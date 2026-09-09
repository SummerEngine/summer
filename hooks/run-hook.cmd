:; exec bash "$(dirname "$0")/run-hook.sh" "$@"
@echo off
rem Summer Engine hook dispatcher — bash / cmd.exe polyglot.
rem
rem   bash (macOS, Linux, Git Bash): line 1 is a no-op ":" followed by an exec
rem   into run-hook.sh; nothing below it is ever parsed. No shebang on purpose:
rem   bash falls back to running a shebang-less file as a script, and cmd.exe
rem   would otherwise print an error for the "#!" line.
rem   cmd.exe / PowerShell (Windows without a bash hook shell): line 1 is a
rem   label and is skipped; the batch below locates Git Bash and forwards, or
rem   exits 0 so a missing bash never blocks the host.
rem
rem Usage: run-hook.cmd <hook-name>   (stdin is forwarded untouched)
setlocal
set "HOOK_DIR=%~dp0"
where bash >nul 2>nul
if %errorlevel%==0 (
  bash "%HOOK_DIR%run-hook.sh" %*
  exit /b %errorlevel%
)
if exist "%ProgramFiles%\Git\bin\bash.exe" (
  "%ProgramFiles%\Git\bin\bash.exe" "%HOOK_DIR%run-hook.sh" %*
  exit /b %errorlevel%
)
if exist "%LocalAppData%\Programs\Git\bin\bash.exe" (
  "%LocalAppData%\Programs\Git\bin\bash.exe" "%HOOK_DIR%run-hook.sh" %*
  exit /b %errorlevel%
)
echo Summer hooks need Git Bash on Windows; skipping hook. 1>&2
exit /b 0
