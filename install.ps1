# Install TropaAI on Windows. It runs inside WSL 2 (Linux, built into Windows).
#   Double-click TropaAI-Setup.cmd, or paste into PowerShell:
#   irm https://raw.githubusercontent.com/makmac213/tropa-ai/main/install.ps1 | iex
#
# What it does, asking before anything big:
#   1. Turns on WSL if it's off (one Windows permission prompt; if Windows needs a restart, setup
#      carries on by itself after it), installs Ubuntu, and walks you through creating your Linux user.
#   2. Installs tmux, python3, curl and git in Ubuntu (as WSL's administrator: no password to type).
#   3. Runs tropa's Linux installer inside WSL: it adds Node.js and an AI agent (Claude Code and/or
#      OpenCode) if they're missing, installs tropa and opens it in your browser.
#   4. Adds a `tropa` command, "TropaAI" shortcuts on the Desktop and Start menu (and, if you like,
#      one that starts it when you sign in), and offers to sign in to your AI agent.
#
# Options (environment variables): TROPA_DISTRO (default: Ubuntu, else your default distro),
#   TROPA_VERSION, TROPA_REPO, TROPA_NO_SHIM=1 (no Windows command or shortcuts), TROPA_YES=1 (answer yes).
# A log of each run is kept in %TEMP%\tropa-install.log.
# Works with Windows PowerShell 5.1 and PowerShell 7. Keep this file ASCII-only.

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$Repo = if ($env:TROPA_REPO) { $env:TROPA_REPO } else { 'makmac213/tropa-ai' }
$SelfUrl = "https://raw.githubusercontent.com/$Repo/main/install.ps1"
$Log = Join-Path $env:TEMP 'tropa-install.log'
try { Start-Transcript -Path $Log -Append | Out-Null } catch {}

function Say([string]$m) { Write-Host $m }
function Ok([string]$m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Info([string]$m) { Write-Host "       $m" }
function Done() { try { Stop-Transcript | Out-Null } catch {} }
function Fail([string]$m) {
    Write-Host ''
    Write-Host "  [x] $m" -ForegroundColor Red
    Write-Host ''
    Write-Host "  If you need help, send the log: $Log"
    Done
    throw "TropaAI setup stopped: $m"
}
function Step([int]$n, [string]$m) { Write-Host ''; Write-Host "=== Step $n of 4 - $m" -ForegroundColor Cyan; Write-Host '' }
function Ask([string]$q) {
    if ($env:TROPA_YES -eq '1') { return $true }
    $a = Read-Host "  $q [Y/n]"
    return ($a -eq '' -or $a -match '^[Yy]')
}

# wsl.exe prints UTF-16 unless WSL_UTF8=1 (newer WSL); strip NULs either way.
# (Windows PowerShell 5.1 turns native stderr into errors under 'Stop', so relax it here.)
$script:WslRc = 0
function WslOut([string[]]$wslArgs) {
    $env:WSL_UTF8 = '1'
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = & wsl.exe @wslArgs 2>&1 | Out-String; $script:WslRc = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
    return ($out -replace "`0", '')
}
# Plain words for the errors people actually hit
function Explain([string]$text) {
    if ($text -match '0x80370102|0x80370114|HCS_E_HYPERV|[Vv]irtuali[sz]ation|Virtual Machine Platform') {
        Fail ("Virtualization is turned off on this computer, and WSL needs it.`n" +
              "       Turn it on in your computer's BIOS/UEFI settings (often called Intel VT-x, AMD-V or SVM):`n" +
              "       restart, press the setup key while it starts (often F2, F10, Del or Esc), enable it, save, and run this setup again.`n" +
              "       Your PC maker's support site shows the exact steps for your model.")
    }
}
# Bash commands go through a temporary script file, never the command line: Windows PowerShell 5.1
# mangles double quotes in arguments to native programs.
function ScriptFile([string]$cmd) {
    $f = Join-Path $env:TEMP ('tropa-' + [guid]::NewGuid().ToString('N') + '.sh')
    [IO.File]::WriteAllText($f, ($cmd -replace "`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding $false))
    $lp = (WslOut @('-d', $script:Distro, '-e', 'wslpath', '-a', $f)).Trim()
    if ($lp -notmatch '^/') { Remove-Item $f -Force -ErrorAction SilentlyContinue; Explain $lp; Fail "WSL could not reach $env:TEMP ($lp). Open Ubuntu from the Start menu once, then run this setup again." }
    return @($f, $lp)
}
# Run in the distro (as its default user, or as root with -Root), attached to this console so output
# shows live and programs can ask questions.
function InWsl([string]$cmd, [switch]$Root) {
    $f, $lp = ScriptFile $cmd
    $u = if ($Root) { '-u root ' } else { '' }
    try {
        $p = Start-Process -FilePath 'wsl.exe' -ArgumentList "-d `"$($script:Distro)`" $u-e bash -l `"$lp`"" -NoNewWindow -Wait -PassThru
        return [int]$p.ExitCode
    } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}
function InWslOut([string]$cmd) {
    $f, $lp = ScriptFile $cmd
    try { return (WslOut @('-d', $script:Distro, '-e', 'bash', '-l', $lp)).Trim() } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}
function Distros() {
    $list = WslOut @('-l', '-v')
    $all = @(); $script:DefaultDistro = ''
    foreach ($line in ($list -split "`r?`n")) {
        # "* Ubuntu   Running   2": name, a (possibly localized) state, version digit at the end
        if ($line -match '^\s*(\*?)\s*(\S+)\s+\S.*\s(\d)\s*$') {
            $d = [pscustomobject]@{ Name = $Matches[2]; Version = [int]$Matches[3] }
            $all += $d
            if ($Matches[1] -eq '*') { $script:DefaultDistro = $d.Name }
        }
    }
    return @($all | Where-Object { $_.Name -notmatch '^docker-desktop' })
}
function WslReady() { [void](WslOut @('--status')); return ($script:WslRc -eq 0) }
# After a restart, Windows runs this once, which picks setup up again
function ResumeAfterRestart() {
    $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -Command `"`$env:TROPA_REPO='$Repo'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm $SelfUrl | iex`""
    New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Force | Out-Null
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'TropaAISetup' -Value $cmd
}
function RestartNow() {
    ResumeAfterRestart
    Say ''
    Say '  Windows needs to restart to finish turning on WSL.'
    Say '  After the restart, sign in and this setup opens again by itself and carries on.'
    if (Ask 'Restart now? (save your work in other apps first)') { Done; Restart-Computer -Force; return }
    Say '  OK. Restart whenever you are ready; setup carries on after it.'
    Done
}   # callers `return` right after: `exit` would close the PowerShell window this runs in
# Wait until the distro has a normal (non-root) default user: Ubuntu's own first-run asks for one
function WaitForLinuxUser([bool]$openWindow) {
    Say ''
    Say "  Ubuntu needs a user name and password for you (just for Linux; they don't have to match Windows)."
    if ($openWindow) { Start-Process -FilePath 'wsl.exe' -ArgumentList "-d `"$($script:Distro)`"" | Out-Null }
    Say '  In the Ubuntu window:'
    Say '    1. Type a user name: lowercase letters, no spaces (for example: maria). Press Enter.'
    Say "    2. Type a password and press Enter, then type it again. Nothing shows while you type; that's normal."
    Say '       Write it down: Linux asks for it now and then.'
    Say '    3. When you see a line ending in $, you are done: type  exit  and press Enter (or just close that window).'
    Say ''
    Say '  Waiting for you to finish...'
    for ($i = 0; $i -lt 720; $i++) {   # up to an hour
        Start-Sleep -Seconds 5
        $uid = (WslOut @('-d', $script:Distro, '-e', 'id', '-u')).Trim()
        if ($script:WslRc -eq 0 -and $uid -match '^\d+$' -and $uid -ne '0') { Ok "Linux user created: $((WslOut @('-d', $script:Distro, '-e', 'id', '-un')).Trim())"; return }
        if ($i -gt 0 -and $i % 24 -eq 0) { Info "...still waiting ($([int]($i / 12)) min). Finish creating your user in the Ubuntu window." }
    }
    Fail "Ubuntu's user wasn't created within an hour. Open Ubuntu from the Start menu, create your user, then run this setup again."
}

Say ''
Say 'Setting up TropaAI on Windows. It runs inside WSL 2 (Linux, built into Windows):'
Say '  1. turn on WSL and set up Ubuntu   2. add the Linux tools TropaAI needs'
Say '  3. install TropaAI                 4. add shortcuts and sign in to your AI agent'
Say 'It usually takes 10-20 minutes the first time. You can stop it with Ctrl+C and run it again later.'

# ---- 1. Windows + WSL
Step 1 'Turning on WSL and setting up Ubuntu'
$build = [Environment]::OSVersion.Version.Build
if ($IsWindows -ne $false -and $build -lt 19041) { Fail "This Windows is too old for WSL 2 (build $build). Update Windows 10 to version 2004 or newer (Settings > Windows Update), then run this setup again." }
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Fail 'WSL is not available on this Windows. Install the latest updates (Settings > Windows Update), then run this setup again.' }

if (-not (WslReady)) {
    Say '  WSL is off. It lets Windows run Linux, which TropaAI needs.'
    Say '  Windows will ask for permission (click Yes), then download it. It may need a restart afterwards.'
    if (-not (Ask 'Turn on WSL now?')) { Fail 'TropaAI needs WSL. Run this setup again when you are ready.' }
    try { $p = Start-Process -FilePath 'wsl.exe' -ArgumentList '--install --no-distribution' -Verb RunAs -Wait -PassThru }
    catch { Fail 'Windows did not get permission to turn on WSL (the prompt was closed or No was clicked). Run this setup again and click Yes.' }
    if ($p.ExitCode -ne 0) {   # older WSL doesn't know --no-distribution: the plain install adds Ubuntu too
        try { $p = Start-Process -FilePath 'wsl.exe' -ArgumentList '--install' -Verb RunAs -Wait -PassThru } catch { Fail 'Windows did not get permission to turn on WSL. Run this setup again and click Yes.' }
    }
    if (-not (WslReady)) { RestartNow; return }
    Ok 'WSL is on'
}
Explain (WslOut @('--status'))

$distros = Distros
$newDistro = $false
if ($distros.Count -eq 0) {
    Say '  Installing Ubuntu (the Linux system TropaAI runs in). It downloads about 500 MB.'
    $p = Start-Process -FilePath 'wsl.exe' -ArgumentList '--install -d Ubuntu --no-launch' -NoNewWindow -Wait -PassThru
    $distros = Distros
    if ($distros.Count -eq 0) {
        if (-not (WslReady)) { RestartNow; return }
        # Store-app Ubuntu finishes installing on its first start, in its own window, and asks for the user there
        $ubuntu = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\ubuntu.exe'
        if (Test-Path $ubuntu) {
            $script:Distro = 'Ubuntu'
            Start-Process -FilePath $ubuntu | Out-Null
            WaitForLinuxUser $false
            $distros = Distros
        }
    }
    if ($distros.Count -eq 0) {
        Explain (WslOut @('--install', '-d', 'Ubuntu', '--no-launch'))
        Fail 'Ubuntu could not be installed. Open the Microsoft Store, install "Ubuntu", open it once, then run this setup again.'
    }
    $newDistro = $true
    Ok 'Ubuntu installed'
}

$script:Distro = $env:TROPA_DISTRO
if (-not $script:Distro) {
    $u = $distros | Where-Object { $_.Name -eq 'Ubuntu' } | Select-Object -First 1
    if ($u) { $script:Distro = $u.Name } elseif ($script:DefaultDistro) { $script:Distro = $script:DefaultDistro } else { $script:Distro = $distros[0].Name }
}
$picked = $distros | Where-Object { $_.Name -eq $script:Distro } | Select-Object -First 1
if (-not $picked) { Fail "WSL distribution '$($script:Distro)' was not found. Installed: $(($distros | ForEach-Object Name) -join ', ')" }
if ($picked.Version -ne 2) {
    Warn "$($script:Distro) runs on WSL 1. TropaAI needs WSL 2 (faster, and the browser can reach it)."
    if (Ask "Convert $($script:Distro) to WSL 2 now? (takes a few minutes)") { Start-Process -FilePath 'wsl.exe' -ArgumentList "--set-version `"$($script:Distro)`" 2" -NoNewWindow -Wait | Out-Null }
    else { Fail "TropaAI needs WSL 2. Convert it with: wsl --set-version $($script:Distro) 2" }
}
Explain (WslOut @('-d', $script:Distro, '-e', 'true'))
Ok "Linux: $($script:Distro) on WSL 2"

# a fresh Ubuntu (or one whose first start was never finished) logs in as root: create the user first
$uid = (WslOut @('-d', $script:Distro, '-e', 'id', '-u')).Trim()
if ($uid -eq '0') {
    $hasUser = (WslOut @('-d', $script:Distro, '-e', 'getent', 'passwd', '1000')).Trim()
    if ($newDistro -or -not $hasUser) { WaitForLinuxUser $true }
    else { Warn "$($script:Distro) logs in as root. That works, but a normal user is safer: https://learn.microsoft.com/windows/wsl/basic-commands" }
} else { Ok "Linux user: $((WslOut @('-d', $script:Distro, '-e', 'id', '-un')).Trim())" }

# ---- 2. Linux packages (as WSL's root: no sudo password to type)
Step 2 'Adding the Linux tools TropaAI needs'
$missing = InWslOut 'for b in tmux python3 curl git; do command -v $b >/dev/null 2>&1 || printf "%s " $b; done'
if ($missing) {
    if (-not (InWslOut 'command -v apt-get || true')) { Fail "$($script:Distro) has no apt-get. Install these with its package manager, then run this setup again: $missing" }
    Say "  Installing: $missing"
    $rc = InWsl "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq $missing" -Root
    if ($rc -ne 0) { Fail "Could not install $missing. Check your internet connection and run this setup again." }
}
Ok 'tmux, python3, curl and git are installed'
$docker = InWslOut 'docker info >/dev/null 2>&1 && echo yes || true'
if ($docker -eq 'yes') { Ok 'Docker is available in WSL (the chat server can run in it)' }

# ---- 3. tropa itself (the Linux installer, inside WSL; it adds Node.js and the AI agent too)
Step 3 'Installing TropaAI inside WSL'
$envs = "TROPA_REPO='$Repo'"
if ($env:TROPA_VERSION) { $envs += " TROPA_VERSION='$($env:TROPA_VERSION)'" }
if ($env:TROPA_YES -eq '1') { $envs += " TROPA_YES=1" }
if ($env:TROPA_ARCHIVE) {   # local test archive: translate the Windows path for WSL
    $p = InWslOut "wslpath -a '$($env:TROPA_ARCHIVE -replace '\\', '/')'"
    $envs += " TROPA_ARCHIVE='$p'"
}
$rc = InWsl "curl -fsSL https://raw.githubusercontent.com/$Repo/main/install.sh -o /tmp/tropa-install.sh && $envs bash /tmp/tropa-install.sh; r=`$?; rm -f /tmp/tropa-install.sh; exit `$r"
if ($rc -ne 0) { Fail 'TropaAI is not installed yet: follow the steps printed above, then run this setup again.' }
$ver = InWslOut 'tropa version 2>/dev/null || ~/.local/bin/tropa version'
Ok $ver

# ---- 4. Windows command, shortcuts, sign-in
Step 4 'Shortcuts and signing in'
if ($env:TROPA_NO_SHIM -ne '1') {
    $root = Join-Path $env:LOCALAPPDATA 'tropa'
    $bin = Join-Path $root 'bin'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $cmd = @"
@echo off
rem tropa for Windows: runs tropa inside WSL ($($script:Distro)). Created by install.ps1.
rem From a folder on a Windows drive it starts in that folder; elsewhere it starts in your Linux home.
setlocal
set "TROPA_DISTRO=$($script:Distro)"
set "TROPA_CD=%CD%"
rem CMD can't start in \\wsl.localhost\... folders and falls back to C:\Windows: use the Linux home then.
if /i "%CD:~0,10%"=="%SystemRoot:~0,10%" set "TROPA_CD=~"
wsl.exe -d %TROPA_DISTRO% --cd "%TROPA_CD%" -e bash -lc "exec tropa \"`$@\"" tropa %*
"@
    Set-Content -Path (Join-Path $bin 'tropa.cmd') -Value $cmd -Encoding ASCII
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if (($userPath -split ';') -notcontains $bin) {
        [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin).TrimStart(';'), 'User')
        $env:Path = $env:Path + ';' + $bin
    }
    Ok 'The tropa command works from PowerShell and CMD too'

    # "TropaAI" shortcuts: start it and open the browser, in a minimized window
    $icon = Join-Path $root 'tropa.ico'
    try { Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/$Repo/main/docs/assets/tropa.ico" -OutFile $icon } catch { $icon = $null }
    $shell = New-Object -ComObject WScript.Shell
    function Shortcut([string]$path, [string]$arguments) {
        $s = $shell.CreateShortcut($path)
        $s.TargetPath = Join-Path $bin 'tropa.cmd'; $s.Arguments = $arguments; $s.WindowStyle = 7
        $s.WorkingDirectory = $env:USERPROFILE; $s.Description = 'Start TropaAI and open it in your browser'
        if ($icon) { $s.IconLocation = $icon }
        $s.Save()
    }
    Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'TropaAI.lnk') 'start'
    Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'TropaAI.lnk') 'start'
    Ok 'TropaAI shortcuts are on your Desktop and in the Start menu: double-click to start it'
    $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'TropaAI.lnk'
    if (-not (Test-Path $startup)) {
        if (Ask 'Start TropaAI automatically when you sign in to Windows? (it runs in the background; open it with the shortcut)') {
            Shortcut $startup 'start --no-open'
            Ok 'TropaAI starts when you sign in (remove it any time: delete TropaAI from shell:startup)'
        }
    }
}

# sign in to the AI agent now, while we're here
$agent = InWslOut @'
if command -v claude >/dev/null 2>&1; then
  if [ -s ~/.claude/.credentials.json ] || grep -qs '"oauthAccount"' ~/.claude.json || [ -n "$ANTHROPIC_API_KEY" ]; then echo claude-in; else echo claude-out; fi
elif command -v opencode >/dev/null 2>&1; then
  if [ -s ~/.local/share/opencode/auth.json ]; then echo opencode-in; else echo opencode-out; fi
fi
'@
$unattended = ($env:TROPA_YES -eq '1')   # nobody to type at a sign-in screen
if ($agent -eq 'claude-out') {
    Say '  Claude Code needs you to sign in once.'
    if (-not $unattended -and (Ask 'Sign in to Claude Code now?')) {
        Say '  Claude Code opens here. Choose how to sign in and finish in your browser'
        Say '  (if no browser opens, hold Ctrl and click the link). Then type /exit and press Enter to come back.'
        Read-Host '  Press Enter to start' | Out-Null
        [void](InWsl 'cd ~ && claude')
    } else { Info "Later: open Ubuntu from the Start menu, type  claude  and press Enter." }
} elseif ($agent -eq 'opencode-out') {
    Say '  OpenCode needs a provider (some have free models).'
    if (-not $unattended -and (Ask 'Set up OpenCode now?')) {
        Say '  OpenCode opens here. Type /connect, pick a provider and follow the steps. Press Ctrl+C to come back.'
        Read-Host '  Press Enter to start' | Out-Null
        [void](InWsl 'cd ~ && opencode')
    } else { Info "Later: open Ubuntu from the Start menu, type  opencode  and press Enter, then /connect." }
} elseif ($agent -match '-in$') { Ok 'Your AI agent is signed in' }

$home_ = InWslOut 'echo $HOME'
Say ''
Write-Host 'Done. TropaAI is installed.' -ForegroundColor Green
if ($env:TROPA_NO_SHIM -ne '1') { Say '  - Start it: double-click TropaAI on your Desktop (or type  tropa start  in PowerShell).' }
else { Say '  - Start it: open Ubuntu from the Start menu and type  tropa start' }
Say '  - It opens in your browser at http://localhost:8888'
Say "  - Your projects are in Linux; in File Explorer: \\wsl.localhost\$($script:Distro)$($home_ -replace '/', '\')\projects"
Say '  Keep projects there (not on C:) - it is much faster and dev servers see file changes.'
Say ''
Done
