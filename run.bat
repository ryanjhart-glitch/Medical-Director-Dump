@echo off
:: Medical Director Candidate Sourcer — Daily Run Script
:: Place this file in the repo folder on your desktop.
:: Point Windows Task Scheduler at this file to automate daily runs.

:: Change to the folder where this .bat file lives (the repo root)
cd /d "%~dp0"

:: Run the sourcer
node candidate-sourcer.js >> run.log 2>&1

:: Exit cleanly (Task Scheduler needs this)
exit /b 0
