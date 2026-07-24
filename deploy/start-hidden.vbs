' Sobe o bot sem nenhuma janela visivel.
'
' O node e um programa de console: rodar direto sempre abre um terminal. Este
' lancador usa o WScript.Shell com estilo de janela 0 (oculta) para evitar isso.
'
' A saida vai para botdc.log em vez de se perder — sem janela, seria a unica
' forma de descobrir por que o bot parou.

Dim sh, raiz, code
Set sh = CreateObject("WScript.Shell")

' Pasta do proprio script, subindo um nivel (deploy -> raiz do projeto).
raiz = CreateObject("Scripting.FileSystemObject").GetParentFolderName( _
         CreateObject("Scripting.FileSystemObject").GetParentFolderName( _
           WScript.ScriptFullName))

sh.CurrentDirectory = raiz

' O terceiro argumento True faz o wscript ESPERAR o node terminar. Sem isso o
' wscript sai na hora, a tarefa agendada fica "Ready" (concluida) e o node roda
' orfao — e ai Stop-ScheduledTask nao consegue mais mata-lo. Esperando, a tarefa
' fica "Running" enquanto o bot vive e para de verdade quando pedido.
'
' O ">" sobrescreve o log a cada inicio; troque por ">>" para acumular.
code = sh.Run("cmd /c node src\index.js > botdc.log 2>&1", 0, True)

' Propaga o codigo de saida: se o node cair (codigo != 0), a tarefa ve falha e
' reinicia sozinha pela politica de RestartCount.
WScript.Quit code
