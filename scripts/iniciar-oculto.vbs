' Executa servidor.cmd sem abrir janela. A tarefa agendada fica ativa enquanto o script roda.
Set shell = CreateObject("WScript.Shell")
pasta = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WScript.Quit shell.Run("cmd /c """ & pasta & "\servidor.cmd""", 0, True)
