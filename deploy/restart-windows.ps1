# Reinicia o bot no Windows garantindo UMA unica instancia.
#
#   powershell -ExecutionPolicy Bypass -File deploy\restart-windows.ps1
#
# Existe porque reiniciar so com Stop/Start-ScheduledTask pode deixar uma
# instancia orfa viva e subir outra por cima - dois bots respondendo em dobro.
# Este script para a tarefa, mata qualquer node do bot que sobre, e sobe um so.

$ErrorActionPreference = 'Stop'
$nome = 'botdc'

$daBot = {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*index.js*' }
}

Write-Host "Parando..."
Stop-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

foreach ($p in & $daBot) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host "  encerrei PID $($p.ProcessId)"
}
Start-Sleep -Seconds 2

$restam = @(& $daBot).Count
if ($restam -ne 0) {
  Write-Host "Ainda ha $restam instancia(s) de pe; abortando para nao empilhar." -ForegroundColor Red
  exit 1
}

Write-Host "Subindo..."
Start-ScheduledTask -TaskName $nome
Start-Sleep -Seconds 6

$agora = @(& $daBot)
if ($agora.Count -eq 1) {
  Write-Host "OK - 1 instancia rodando (PID $($agora[0].ProcessId))." -ForegroundColor Green
  Write-Host "Log: Get-Content '$PSScriptRoot\..\botdc.log' -Tail 20 -Wait"
} else {
  Write-Host "Esperava 1 instancia, ha $($agora.Count). Veja o botdc.log." -ForegroundColor Yellow
}
