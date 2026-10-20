@echo off
chcp 65001 >nul
REM Lance par le Planificateur de taches Windows toutes les 5 minutes
REM (voir la tache planifiee "FlexPayPerDiem"). Se contente d'appeler le
REM script Node reel et de garder une trace dans per-diem.log - utile pour
REM verifier que l'automatisation tourne bien sans avoir a laisser un
REM terminal ouvert.
cd /d "C:\Users\Dell\Documents\Flexpay\flexpay-backend"
"C:\Program Files\nodejs\node.exe" scripts\run-per-diem.js >> scripts\per-diem.log 2>&1
