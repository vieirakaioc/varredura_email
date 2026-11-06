# Registra a tarefa "Validador Fiscal" no Agendador de Tarefas do Windows.
#
# Sem parâmetro: inicia quando o usuário atual entra no Windows (não precisa de administrador).
#   .\scripts\instalar-tarefa.ps1
#
# Com -AoIniciar: inicia junto com o computador, como SYSTEM, sem depender de ninguém fazer login.
# É o modo indicado para a máquina que serve a equipe — se o PC reiniciar de madrugada, o sistema
# volta sozinho. Exige executar o PowerShell como administrador.
#   .\scripts\instalar-tarefa.ps1 -AoIniciar
#
# Para remover: .\scripts\remover-tarefa.ps1
param([switch]$AoIniciar)
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot 'iniciar-oculto.vbs'

if ($AoIniciar) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { throw 'Rode o PowerShell como administrador para instalar a tarefa com -AoIniciar.' }
}

$acao = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $raiz
if ($AoIniciar) {
  # Atraso de 1 minuto: dá tempo de a rede subir antes do sistema tentar falar com o Senior
  $gatilho = New-ScheduledTaskTrigger -AtStartup
  $gatilho.Delay = 'PT1M'
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
} else {
  $gatilho = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
}
$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'Validador Fiscal' -Description 'Validador Fiscal: leitura dos e-mails de NFS-e, conciliação com o Senior e painel em http://localhost:3000' `
  -Action $acao -Trigger $gatilho -Settings $config -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'Validador Fiscal'
Write-Output ('Tarefa "Validador Fiscal" registrada e iniciada ({0}).' -f $(if ($AoIniciar) { 'ao iniciar o computador, como SYSTEM' } else { 'ao entrar no Windows' }))
