@echo off
rem Mantem o Validador Fiscal no ar: se o processo cair, espera 10 s e sobe de novo.
rem Chamado pela tarefa "Validador Fiscal" do Agendador de Tarefas (via iniciar-oculto.vbs).
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
:inicio
echo [%date% %time%] Iniciando servidor >> data\logs\servidor.log
"C:\Program Files\nodejs\node.exe" --env-file-if-exists=.env server\src\index.js >> data\logs\servidor.log 2>&1
echo [%date% %time%] Servidor parou (codigo %errorlevel%), reiniciando em 10 s >> data\logs\servidor.log
timeout /t 10 /nobreak > nul
goto inicio
