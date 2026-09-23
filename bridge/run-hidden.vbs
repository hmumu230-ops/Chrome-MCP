' Launches the bridge supervisor with no console window (for Task Scheduler / manual autostart).
Set shell = CreateObject("Wscript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
shell.Run "node """ & dir & "\watchdog.mjs""", 0, False
