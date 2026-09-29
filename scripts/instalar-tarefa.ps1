# Registra a tarefa "Validador Fiscal" no Agendador de Tarefas do Windows (usuário atual, sem administrador).
# Inicia ao entrar no Windows, reinicia se falhar e não tem limite de tempo de execução.
# Para remover: .\scripts\remover-tarefa.ps1
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot 'iniciar-oculto.vbs'

$acao = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $raiz
$gatilho = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'Validador Fiscal' -Description 'Validador Fiscal: leitura dos e-mails de NFS-e, conciliação com o Senior e painel em http://localhost:3000' `
  -Action $acao -Trigger $gatilho -Settings $config -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'Validador Fiscal'
Write-Output 'Tarefa "Validador Fiscal" registrada e iniciada.'
