# Para o Validador Fiscal e remove a tarefa do Agendador de Tarefas.
Stop-ScheduledTask -TaskName 'Validador Fiscal' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server\src\index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object { $_.CommandLine -like '*servidor.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Unregister-ScheduledTask -TaskName 'Validador Fiscal' -Confirm:$false
Write-Output 'Tarefa "Validador Fiscal" removida.'
