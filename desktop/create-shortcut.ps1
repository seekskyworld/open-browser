$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'open-browser.lnk'))
$link.TargetPath = Join-Path $PSScriptRoot 'node\node.exe'
$link.Arguments = '"' + (Join-Path $PSScriptRoot 'app\service.mjs') + '" --chromium'
$link.WorkingDirectory = $PSScriptRoot
$link.IconLocation = (Join-Path $PSScriptRoot 'open-browser.ico') + ',0'
$link.WindowStyle = 7
$link.Save()
