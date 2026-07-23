' Sobe o bot sem nenhuma janela visivel.
'
' O node e um programa de console: rodar direto sempre abre um terminal. Este
' lancador usa o WScript.Shell com estilo de janela 0 (oculta) para evitar isso.
'
' A saida vai para botdc.log em vez de se perder — sem janela, seria a unica
' forma de descobrir por que o bot parou.

Dim sh, raiz
Set sh = CreateObject("WScript.Shell")

' Pasta do proprio script, subindo um nivel (deploy -> raiz do projeto).
raiz = CreateObject("Scripting.FileSystemObject").GetParentFolderName( _
         CreateObject("Scripting.FileSystemObject").GetParentFolderName( _
           WScript.ScriptFullName))

sh.CurrentDirectory = raiz

' O ">" sobrescreve a cada inicio: mantem o log do run atual sem crescer sem
' limite. Trocar por ">>" acumula o historico entre reinicios.
sh.Run "cmd /c node src\index.js > botdc.log 2>&1", 0, False
