# Registra o bot como tarefa agendada do Windows: sobe junto com o logon, sem
# janela, e se recupera sozinho de quedas.
#
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1
#
# Nao exige administrador: a tarefa e do seu usuario. Para remover:
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -Remover
#
# Mantido em ASCII de proposito: o Windows PowerShell 5.1 le .ps1 sem BOM como
# ANSI, e acento em UTF-8 vira byte corrompido que quebra o parse do script.

param([switch]$Remover)

$ErrorActionPreference = 'Stop'

$nome = 'botdc'
$raiz = Split-Path -Parent $PSScriptRoot
$lancador = Join-Path $PSScriptRoot 'start-hidden.vbs'

if ($Remover) {
    if (Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $nome -Confirm:$false
        Write-Host "Tarefa '$nome' removida. O bot nao sobe mais no logon." -ForegroundColor Green
        Write-Host "Se ainda estiver rodando agora, encerre pelo Gerenciador de Tarefas."
    } else {
        Write-Host "Nao havia tarefa '$nome' registrada."
    }
    return
}

if (-not (Test-Path (Join-Path $raiz '.env'))) {
    Write-Host "Falta o .env em $raiz - o bot nao sobe sem credenciais." -ForegroundColor Red
    Write-Host "Copie o .env.example para .env e preencha antes de instalar."
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node nao encontrado no PATH." -ForegroundColor Red
    exit 1
}

$acao = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$lancador`"" -WorkingDirectory $raiz
$gatilho = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Sem limite de duracao: o padrao encerraria a tarefa depois de 3 dias. E sem
# parar por bateria, senao o bot cai sozinho em notebook.
$config = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

if (Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $nome -Confirm:$false
}

Register-ScheduledTask -TaskName $nome -Action $acao -Trigger $gatilho -Settings $config `
    -Description 'botdc - bot de Discord que espelha o Spotify em canal de voz' | Out-Null

Start-ScheduledTask -TaskName $nome
Start-Sleep -Seconds 4

$log = Join-Path $raiz 'botdc.log'
if (Get-Process node -ErrorAction SilentlyContinue) {
    Write-Host "`nInstalado e rodando." -ForegroundColor Green
} else {
    Write-Host "`nInstalado, mas o processo node nao apareceu." -ForegroundColor Yellow
    Write-Host "Veja o motivo em: $log"
}

Write-Host ""
Write-Host "  Ver o log:      Get-Content '$log' -Tail 30 -Wait"
Write-Host "  Parar agora:    Stop-ScheduledTask -TaskName $nome"
Write-Host "  Subir de novo:  Start-ScheduledTask -TaskName $nome"
Write-Host "  Desinstalar:    powershell -ExecutionPolicy Bypass -File '$PSCommandPath' -Remover"
Write-Host ""
