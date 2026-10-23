#Requires -RunAsAdministrator
<#
  Removes the Codex Discord bot from Windows: the background task, the
  "codexbot" account and its profile, the app folder and the settings folder.
      powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1
#>
$AppDir   = Join-Path $env:ProgramFiles 'CodexDiscordBot'
$DataDir  = Join-Path $env:ProgramData 'CodexDiscordBot'
$BotUser  = 'codexbot'
$TaskName = 'CodexDiscordBot'

$answer = Read-Host "This deletes the bot, its settings (including the token) and the '$BotUser' account. Continue? [y/N]"
if ($answer -notmatch '^[yY]') { exit }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$user = Get-LocalUser -Name $BotUser -ErrorAction SilentlyContinue
if ($user) {
  Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $user.SID.Value } | Remove-CimInstance
  Remove-LocalUser -Name $BotUser
}
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList' `
  -Name $BotUser -ErrorAction SilentlyContinue

Remove-Item -Recurse -Force $AppDir, $DataDir -ErrorAction SilentlyContinue
Write-Host 'Codex Discord bot removed.' -ForegroundColor Green
