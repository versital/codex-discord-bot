#Requires -RunAsAdministrator
<#
  Installs the Codex Discord bot on Windows 10/11 as a background task that
  starts with the PC and runs under its own low-privilege "codexbot" account.

  Run from an *administrator* PowerShell, in this folder:
      powershell -ExecutionPolicy Bypass -File .\install-windows.ps1

  Options:
      -SkipFfmpeg    don't install ffmpeg (videos / odd image formats won't work)
      -SkipPoppler   don't install Poppler (PDFs won't work)
      -ReplaceApp    reinstall the bot code from this folder even if a (possibly
                     newer, updated) version is already installed

  Re-running it is safe: settings, chats and the installed version are kept.
  Day-to-day updates happen with /admin update in Discord.
#>
param([switch]$SkipFfmpeg, [switch]$SkipPoppler, [switch]$ReplaceApp)

$AppDir   = Join-Path $env:ProgramFiles 'CodexDiscordBot'   # just the launcher
$DataDir  = Join-Path $env:ProgramData 'CodexDiscordBot'    # settings, chats, bot versions
$AppRoot  = Join-Path $DataDir 'app'
$EnvFile  = Join-Path $DataDir 'bot.env'
$LogFile  = Join-Path $DataDir 'bot.log'
$BotUser  = 'codexbot'
$TaskName = 'CodexDiscordBot'
$Src      = $PSScriptRoot

function Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host "!! $Message" -ForegroundColor Red; exit 1 }
function Have([string]$Cmd) { [bool](Get-Command $Cmd -ErrorAction SilentlyContinue) }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Winget-Install([string]$Id) {
  if (-not (Have winget)) {
    Write-Warning "winget isn't available, so $Id has to be installed by hand."
    return
  }
  winget install --id $Id --exact --scope machine --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    # Some packages only install per-user.
    winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements
  }
  Refresh-Path
}

function Unsecure([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function New-RandomPassword {
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%*-_=+'
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  'Aa1!' + (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] }))
}

# Finds the folder holding a tool's .exe. Anything inside a user profile is
# copied into the app folder, because the bot account can't see other profiles.
function Resolve-ToolDir([string]$Exe, [string]$Name, [string[]]$Only) {
  $dir = $null
  $cmd = Get-Command $Exe -ErrorAction SilentlyContinue
  if ($cmd) {
    $item = Get-Item $cmd.Source
    $real = $item.FullName
    if ($item.LinkType -and $item.Target) { $real = @($item.Target)[0] }
    $dir = Split-Path $real
  }
  if (-not $dir) {
    foreach ($root in @("$env:ProgramFiles\WinGet\Packages", "$env:LOCALAPPDATA\Microsoft\WinGet\Packages")) {
      if (Test-Path $root) {
        $hit = Get-ChildItem $root -Recurse -Filter $Exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { $dir = $hit.DirectoryName; break }
      }
    }
  }
  if (-not $dir) { return $null }
  if ($dir -like "$env:SystemDrive\Users\*") {
    $dest = Join-Path $AppDir "tools\$Name"
    New-Item -ItemType Directory -Force $dest | Out-Null
    if ($Only) {
      foreach ($f in $Only) { Copy-Item (Join-Path $dir $f) $dest -Force }
    } else {
      Copy-Item "$dir\*" $dest -Recurse -Force
    }
    $dir = $dest
  }
  return $dir
}

function Set-EnvValue([string]$Key, [string]$Value) {
  $found = $false
  $lines = @(Get-Content $EnvFile | ForEach-Object {
    if ($_ -match "^$Key=") { $found = $true; "$Key=$Value" } else { $_ }
  })
  if (-not $found) { $lines += "$Key=$Value" }
  Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
}

# ---------------------------------------------------------------------------

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Step 'Stopping the running bot'
  Stop-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
}

Step 'Checking Node.js'
Refresh-Path
$Node = $null
if (Have node) {
  $major = [int](node -p "process.versions.node.split('.')[0]")
  $path = (Get-Command node).Source
  # A Node inside your own profile (nvm etc.) isn't usable by the bot account.
  if ($major -ge 20 -and $path -notlike "$env:SystemDrive\Users\*") { $Node = $path }
}
if (-not $Node) {
  Winget-Install 'OpenJS.NodeJS.LTS'
  $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $candidate) { $Node = $candidate }
}
if (-not $Node) { Fail 'Node.js 20+ is required. Install the LTS from https://nodejs.org (for all users) and re-run.' }
$Npm = Join-Path (Split-Path $Node) 'npm.cmd'
Write-Host "    node: $Node ($(& $Node --version))"

Step "Installing the launcher to $AppDir"
New-Item -ItemType Directory -Force $AppDir | Out-Null
# Older installs kept the bot itself here.
foreach ($old in 'node_modules', 'bot.js', 'attachments.js', 'package.json', 'package-lock.json') {
  Remove-Item (Join-Path $AppDir $old) -Recurse -Force -ErrorAction SilentlyContinue
}
Copy-Item (Join-Path $Src 'launcher.js') $AppDir -Force

$ToolDirs = @()
if (-not $SkipFfmpeg) {
  Step 'Installing ffmpeg (videos, odd image formats)'
  if (-not (Have ffmpeg)) { Winget-Install 'Gyan.FFmpeg' }
  $dir = Resolve-ToolDir 'ffmpeg.exe' 'ffmpeg' @('ffmpeg.exe', 'ffprobe.exe')
  if ($dir) { $ToolDirs += $dir } else { Write-Warning "ffmpeg wasn't found, so videos won't work." }
}
if (-not $SkipPoppler) {
  Step 'Installing Poppler (PDFs)'
  if (-not (Have pdftotext)) { Winget-Install 'oschwartz10612.Poppler' }
  $dir = Resolve-ToolDir 'pdftotext.exe' 'poppler' $null
  if ($dir) { $ToolDirs += $dir } else { Write-Warning "pdftotext wasn't found, so PDFs won't work." }
}

Step "Setting up the '$BotUser' account"
$Password = New-RandomPassword
$Secure = ConvertTo-SecureString $Password -AsPlainText -Force
if (Get-LocalUser -Name $BotUser -ErrorAction SilentlyContinue) {
  Set-LocalUser -Name $BotUser -Password $Secure
} else {
  New-LocalUser -Name $BotUser -Password $Secure -PasswordNeverExpires -AccountNeverExpires `
    -UserMayNotChangePassword -Description 'Runs the Codex Discord bot' | Out-Null
}
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $BotUser -ErrorAction SilentlyContinue  # Users
# Keep it off the sign-in screen.
$hide = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
New-Item -Path $hide -Force | Out-Null
New-ItemProperty -Path $hide -Name $BotUser -Value 0 -PropertyType DWord -Force | Out-Null

$Cred = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$BotUser", $Secure)
$Sid = (Get-LocalUser -Name $BotUser).SID.Value

# Signing in once creates the account's profile folder.
Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/c', 'exit' -Credential $Cred `
  -LoadUserProfile -WorkingDirectory $env:SystemRoot -WindowStyle Hidden -Wait
$BotProfile = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $Sid }).LocalPath
if (-not $BotProfile) { Fail "Couldn't create a profile for $BotUser" }
$CodexHome = Join-Path $BotProfile '.codex'

Step "Setting up $DataDir"
New-Item -ItemType Directory -Force $DataDir | Out-Null
# Only SYSTEM, Administrators and the bot account. Codex's sandbox can't read
# here either, so its commands can't get at the token.
icacls $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${Sid}:(OI)(CI)M" | Out-Null

$currentFile = Join-Path $AppRoot 'current'
$current = ''
if (Test-Path $currentFile) { $current = (Get-Content $currentFile -Raw).Trim() }
if (-not $current -or $ReplaceApp) {
  $name = 'local-' + (Get-Date -Format 'yyyyMMddHHmmss')
  $dest = Join-Path $AppRoot "versions\$name"
  Step "Installing the bot ($name)"
  New-Item -ItemType Directory -Force $dest | Out-Null
  Get-ChildItem $Src -Force | Where-Object { $_.Name -notin @('node_modules', '.git') } |
    Copy-Item -Destination $dest -Recurse -Force
  Push-Location $dest
  & $Npm ci --omit=dev --no-audit --no-fund
  $npmExit = $LASTEXITCODE
  Pop-Location
  if ($npmExit -ne 0) { Fail 'npm ci failed' }
  $sha = ''
  if (Have git) { $sha = (git -C $Src rev-parse HEAD 2>$null) }
  @{ name = $name; source = 'local'; sha = "$sha"; installedAt = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content (Join-Path $dest 'version.json') -Encoding ASCII
  if ($current) { Set-Content (Join-Path $AppRoot 'previous') $current -Encoding ASCII -NoNewline }
  Set-Content $currentFile $name -Encoding ASCII -NoNewline
  $current = $name
} else {
  Step "Keeping the installed bot version ($current). Update it with /admin update in Discord."
}
$CodexJs = Join-Path $AppRoot "versions\$current\node_modules\@openai\codex\bin\codex.js"
if (-not (Test-Path $CodexJs)) { Fail "Codex CLI missing at $CodexJs (try -ReplaceApp)" }

Step 'Configuring Codex for the bot account'
New-Item -ItemType Directory -Force $CodexHome | Out-Null
$codexConfig = Join-Path $CodexHome 'config.toml'
if (-not ((Test-Path $codexConfig) -and (Select-String -Path $codexConfig -Pattern '^\[windows\]' -Quiet))) {
  Add-Content -Path $codexConfig -Value "`r`n[windows]`r`nsandbox = `"unelevated`"" -Encoding ASCII
}

$env:CODEX_HOME = $CodexHome
& $Node $CodexJs login status *> $null
if ($LASTEXITCODE -ne 0) {
  Step 'Logging Codex in'
  $choice = Read-Host 'Log in with [1] a ChatGPT account (device code) or [2] an OpenAI API key? [1/2]'
  if ($choice -eq '2') {
    $key = Unsecure (Read-Host 'OpenAI API key' -AsSecureString)
    $key | & $Node $CodexJs login --with-api-key
  } else {
    & $Node $CodexJs login --device-auth
  }
  if ($LASTEXITCODE -ne 0) { Fail 'Codex login failed. Re-run the installer to try again.' }
}
Remove-Item Env:CODEX_HOME

Step "Writing settings to $EnvFile"
if (-not (Test-Path $EnvFile)) { Copy-Item (Join-Path $Src '.env.example') $EnvFile }
if (-not (Select-String -Path $EnvFile -Pattern '^DISCORD_TOKEN=\S' -Quiet)) {
  $token = Unsecure (Read-Host 'Discord bot token' -AsSecureString)
  if (-not $token) { Fail 'A Discord bot token is required.' }
  Set-EnvValue 'DISCORD_TOKEN' $token.Trim()
}
Set-EnvValue 'CODEX_WORKDIR' ''
Set-EnvValue 'DATA_DIR' $DataDir
Set-EnvValue 'LOG_FILE' $LogFile
Set-EnvValue 'EXTRA_PATH' ($ToolDirs -join ';')

Step 'Testing the Codex sandbox as the bot account'
$testScript = Join-Path $DataDir 'selftest.ps1'
$testLog = Join-Path $DataDir 'selftest.log'
@"
`$t = Join-Path `$env:TEMP 'codex-bot-selftest'
New-Item -ItemType Directory -Force `$t | Out-Null
Set-Content (Join-Path `$t 'probe.txt') 'sandbox-read-ok'
Set-Location `$t
& '$Node' '$CodexJs' sandbox -- powershell -NoProfile -Command "Get-Content probe.txt; Set-Content written.txt x" 2>&1 | Out-File '$testLog' -Encoding utf8
"write-blocked=`$(-not (Test-Path (Join-Path `$t 'written.txt')))" | Out-File '$testLog' -Append -Encoding utf8
Set-Location `$env:TEMP
Remove-Item -Recurse -Force `$t
"@ | Set-Content -Path $testScript -Encoding ASCII
Remove-Item $testLog -ErrorAction SilentlyContinue
Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $testScript `
  -Credential $Cred -LoadUserProfile -WorkingDirectory $DataDir -WindowStyle Hidden -Wait
$result = ''
if (Test-Path $testLog) { $result = Get-Content $testLog -Raw }
Remove-Item $testScript, $testLog -ErrorAction SilentlyContinue
if ($result -notmatch 'write-blocked=True') {
  Write-Host $result
  Fail "Codex's sandbox did NOT block writes for the bot account, so the bot wasn't started. Output is above."
}
if ($result -notmatch 'sandbox-read-ok') {
  Write-Host $result
  Write-Warning "The sandbox couldn't read files in the bot's temp folder, so attachments may not work."
} else {
  Write-Host '    sandbox OK: reads work, writes are blocked'
}

Step 'Registering the background task'
$action = New-ScheduledTaskAction -Execute $Node -Argument "--env-file=`"$EnvFile`" `"$AppDir\launcher.js`"" -WorkingDirectory $AppDir
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  # Every 5 minutes: restarts the bot if it ever crashed (ignored while it's running).
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
  -User "$env:COMPUTERNAME\$BotUser" -Password $Password -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host ''
Write-Host 'Done. The bot is running and will start with Windows.' -ForegroundColor Green
Write-Host "  Logs:      Get-Content '$LogFile' -Tail 50 -Wait"
Write-Host "  Settings:  notepad '$EnvFile'   (then restart the bot)"
Write-Host "  Restart:   Stop-ScheduledTask $TaskName; Start-ScheduledTask $TaskName"
Write-Host '  Update:    /admin update in Discord'
Write-Host '  Remove:    .\uninstall-windows.ps1'
