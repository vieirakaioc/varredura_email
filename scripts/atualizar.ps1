# Atualiza o Validador Fiscal neste computador e confere se a versão nova entrou no ar.
# Uso (PowerShell, na pasta do projeto):  .\scripts\atualizar.ps1
#   ou para outra branch:                 .\scripts\atualizar.ps1 -Branch master
param([string]$Branch = 'claude/inspiring-turing-svpnq0', [int]$Porta = 3000)
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

function Passo($texto) { Write-Host "`n=== $texto" -ForegroundColor Cyan }

Passo "1/6 Backup da pasta data"
if (Test-Path data) {
  $destino = "data_backup_$(Get-Date -Format yyyyMMdd_HHmm)"
  Copy-Item -Recurse data $destino
  Write-Host "Backup em $destino"
}

Passo "2/6 Baixando o código ($Branch)"
git fetch origin
if ($LASTEXITCODE -ne 0) { throw 'git fetch falhou (sem acesso ao GitHub?)' }
# Arquivos do projeto alterados neste computador impediriam o pull: guarda de lado (git stash), sem apagar
$alterados = git status --porcelain --untracked-files=no
if ($alterados) {
  Write-Host 'Arquivos alterados neste computador (guardados com git stash; recupere com "git stash pop" se precisar):' -ForegroundColor Yellow
  $alterados | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
  git stash push -m "atualizar.ps1 $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  if ($LASTEXITCODE -ne 0) { throw 'git stash falhou' }
}
git checkout $Branch
if ($LASTEXITCODE -ne 0) { throw "git checkout $Branch falhou: há arquivos alterados nesta pasta? Rode 'git status' e me mande o resultado." }
git pull origin $Branch
if ($LASTEXITCODE -ne 0) { throw 'git pull falhou' }
$commit = (git rev-parse --short=7 HEAD).Trim()
Write-Host "Código na versão $commit"

Passo "3/6 Instalando dependências"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install falhou' }

Passo "4/6 Compilando a tela (web\dist)"
npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build falhou' }

Passo "5/6 Reiniciando o servidor"
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server*src*index.js*' }
if ($procs) {
  $procs | ForEach-Object { Write-Host "Parando node PID $($_.ProcessId): $($_.CommandLine)"; Stop-Process -Id $_.ProcessId -Force }
  Write-Host 'Aguardando a tarefa "Validador Fiscal" subir o servidor de novo...'
} else {
  Write-Host 'Nenhum servidor rodando. Iniciando a tarefa "Validador Fiscal"...'
  Start-ScheduledTask -TaskName 'Validador Fiscal' -ErrorAction SilentlyContinue
}

Passo "6/6 Conferindo a versão no ar"
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 3
  try {
    $s = Invoke-RestMethod "http://localhost:$Porta/api/saude" -TimeoutSec 3
    if ($s.versao -eq $commit) { $ok = $true; break }
    Write-Host "Servidor respondeu com a versão '$($s.versao)', esperando $commit..."
  } catch { Write-Host 'Servidor ainda não respondeu...' }
}
if ($ok) {
  Write-Host "`nOK: versão $commit no ar em http://localhost:$Porta (recarregue o navegador com Ctrl+Shift+R)" -ForegroundColor Green
} else {
  Write-Host "`nA versão nova NÃO subiu. Últimas linhas do log:" -ForegroundColor Red
  if (Test-Path data\logs\servidor.log) { Get-Content data\logs\servidor.log -Tail 30 }
  Write-Host "`nProcessos node rodando:"
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine | Format-List
}
