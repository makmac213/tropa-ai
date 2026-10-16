# Install tropa on Windows (runs inside WSL 2).
#   irm https://raw.githubusercontent.com/makmac213/tropa-ai/main/install.ps1 | iex
#
# What it does:
#   1. Checks for WSL 2 and a Linux distribution (offers to install Ubuntu if there is none).
#   2. Installs tmux, python3, curl and git inside it (asks for your Linux password once).
#   3. Checks for Docker (Docker Desktop with WSL integration) or Node.js 22.13+, and offers Node.
#   4. Runs tropa's Linux installer inside WSL.
#   5. Adds a `tropa` command to Windows that forwards to tropa in WSL.
#
# Options (environment variables): TROPA_DISTRO (default: Ubuntu, else your default distro),
#   TROPA_VERSION, TROPA_REPO, TROPA_NO_SHIM=1 (skip the Windows command), TROPA_YES=1 (answer yes).
# Works with Windows PowerShell 5.1 and PowerShell 7. Keep this file ASCII-only.

$ErrorActionPreference = 'Stop'
$Repo = if ($env:TROPA_REPO) { $env:TROPA_REPO } else { 'makmac213/tropa-ai' }

function Say([string]$m) { Write-Host $m }
function Ok([string]$m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host "  [x] $m" -ForegroundColor Red; throw "tropa install stopped: $m" }
function Ask([string]$q) {
    if ($env:TROPA_YES -eq '1') { return $true }
    $a = Read-Host "$q [Y/n]"
    return ($a -eq '' -or $a -match '^[Yy]')
}

# wsl.exe prints UTF-16 unless WSL_UTF8=1 (newer WSL); strip NULs either way.
# (Windows PowerShell 5.1 turns native stderr into errors under 'Stop', so relax it here.)
function WslOut([string[]]$wslArgs) {
    $env:WSL_UTF8 = '1'
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = & wsl.exe @wslArgs 2>&1 | Out-String } finally { $ErrorActionPreference = $eap }
    return ($out -replace "`0", '')
}
# Bash commands go through a temporary script file, never the command line: Windows PowerShell 5.1
# mangles double quotes in arguments to native programs.
function ScriptFile([string]$cmd) {
    $f = Join-Path $env:TEMP ('tropa-' + [guid]::NewGuid().ToString('N') + '.sh')
    [IO.File]::WriteAllText($f, ($cmd -replace "`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding $false))
    $lp = (WslOut @('-d', $script:Distro, '-e', 'wslpath', '-a', $f)).Trim()
    if ($lp -notmatch '^/') { Remove-Item $f -Force -ErrorAction SilentlyContinue; Fail "WSL could not reach $env:TEMP ($lp). Is $($script:Distro) set up? Open it once from the Start menu." }
    return @($f, $lp)
}
# Run in the distro as the default user, attached to this console (so sudo can ask for a password).
function InWsl([string]$cmd) {
    $f, $lp = ScriptFile $cmd
    # Start-Process keeps this console attached (output shows live, sudo can prompt) and nothing is
    # captured into the function's return value. Arguments are one pre-quoted string (PS 5.1 safe).
    try {
        $p = Start-Process -FilePath 'wsl.exe' -ArgumentList "-d `"$($script:Distro)`" -e bash -l `"$lp`"" -NoNewWindow -Wait -PassThru
        return [int]$p.ExitCode
    } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}
function InWslOut([string]$cmd) {
    $f, $lp = ScriptFile $cmd
    try { return (WslOut @('-d', $script:Distro, '-e', 'bash', '-l', $lp)).Trim() } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}

Say ''
Say 'tropa for Windows: sets up WSL 2 and installs tropa inside it'
Say ''

# ---- 1. Windows + WSL
$build = [Environment]::OSVersion.Version.Build
if ($IsWindows -ne $false -and $build -lt 19041) { Fail "Windows 10 version 2004 (build 19041) or newer is needed for WSL 2; this is build $build. Update Windows first." }
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Fail 'wsl.exe was not found. Update Windows, then run: wsl --install' }

$list = WslOut @('-l', '-v')
$distros = @()
$default = ''
foreach ($line in ($list -split "`r?`n")) {
    # "* Ubuntu   Running   2": name, a (possibly localized) state, version digit at the end
    if ($line -match '^\s*(\*?)\s*(\S+)\s+\S.*\s(\d)\s*$') {
        $d = [pscustomobject]@{ Name = $Matches[2]; Version = [int]$Matches[3] }
        $distros += $d
        if ($Matches[1] -eq '*') { $default = $d.Name }
    }
}
$distros = @($distros | Where-Object { $_.Name -notmatch '^docker-desktop' })

if ($distros.Count -eq 0) {
    Warn 'No Linux distribution is installed in WSL yet.'
    if (Ask 'Install Ubuntu now? (Windows may ask for administrator rights and a restart)') {
        Start-Process -FilePath 'wsl.exe' -ArgumentList '--install -d Ubuntu' -NoNewWindow -Wait | Out-Null
        Say ''
        Say 'Next:'
        Say '  1. Restart Windows if you were asked to.'
        Say '  2. Open "Ubuntu" from the Start menu once and create your Linux user name and password.'
        Say '  3. Run this installer again.'
        return
    }
    Fail 'tropa needs a WSL distribution. Install one with: wsl --install -d Ubuntu'
}

$script:Distro = $env:TROPA_DISTRO
if (-not $script:Distro) {
    $u = $distros | Where-Object { $_.Name -eq 'Ubuntu' } | Select-Object -First 1
    if ($u) { $script:Distro = $u.Name } elseif ($default) { $script:Distro = $default } else { $script:Distro = $distros[0].Name }
}
$picked = $distros | Where-Object { $_.Name -eq $script:Distro } | Select-Object -First 1
if (-not $picked) { Fail "WSL distribution '$($script:Distro)' was not found. Installed: $(($distros | ForEach-Object Name) -join ', ')" }
if ($picked.Version -ne 2) {
    Warn "$($script:Distro) runs on WSL 1. tropa needs WSL 2 (localhost access, Docker, speed)."
    if (Ask "Convert $($script:Distro) to WSL 2 now? (takes a few minutes)") { Start-Process -FilePath 'wsl.exe' -ArgumentList "--set-version `"$($script:Distro)`" 2" -NoNewWindow -Wait | Out-Null }
    else { Fail "Convert it with: wsl --set-version $($script:Distro) 2" }
}
Ok "WSL 2 distribution: $($script:Distro)"

$user = InWslOut 'id -un'
if ($user -eq 'root') { Warn "$($script:Distro) logs in as root. That works, but a normal user is safer: https://learn.microsoft.com/windows/wsl/basic-commands" }
if (-not (InWslOut 'command -v apt-get || true')) { Warn "No apt-get in $($script:Distro): install tmux, python3, curl and git with its package manager yourself." }

# ---- 2. Linux packages
$missing = InWslOut 'for b in tmux python3 curl git; do command -v $b >/dev/null 2>&1 || printf "%s " $b; done'
if ($missing) {
    Say "Installing inside $($script:Distro): $missing(sudo will ask for your Linux password)"
    $rc = InWsl "sudo apt-get update -qq && sudo apt-get install -y $missing"
    if ($rc -ne 0) { Fail "Could not install $missing. Open $($script:Distro) and run: sudo apt-get install -y $missing" }
}
Ok 'tmux, python3, curl and git are installed'

# ---- 3. Docker or Node for the chat server
$docker = InWslOut 'docker info >/dev/null 2>&1 && echo yes || true'
$nodeOk = InWslOut 'node -e "const [a,b]=process.versions.node.split(\".\").map(Number);process.exit(a>22||(a==22&&b>=13)?0:1)" 2>/dev/null && echo yes || true'
if ($docker -eq 'yes') { Ok 'Docker is available in WSL (the chat server and Kokoro voices run in containers)' }
elseif ($nodeOk -eq 'yes') { Ok "Node.js $(InWslOut 'node -v') is available (the chat server runs on Node)" }
else {
    Warn 'The chat server needs Docker or Node.js 22.13+ inside WSL.'
    Say  '     Docker: install Docker Desktop, then Settings > Resources > WSL integration > turn on your distro.'
    if (Ask 'Install Node.js 22 inside WSL now instead? (NodeSource packages, needs sudo)') {
        $rc = InWsl 'curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh && sudo -E bash /tmp/nodesource_setup.sh && sudo apt-get install -y nodejs && rm -f /tmp/nodesource_setup.sh'
        if ($rc -eq 0) { Ok "Node.js $(InWslOut 'node -v') installed" } else { Warn 'Node.js install failed; install Docker Desktop or Node 22 later.' }
    }
}

# ---- 4. tropa itself (the Linux installer, inside WSL)
$envs = "TROPA_REPO='$Repo'"
if ($env:TROPA_VERSION) { $envs += " TROPA_VERSION='$($env:TROPA_VERSION)'" }
if ($env:TROPA_ARCHIVE) {   # local test archive: translate the Windows path for WSL
    $p = InWslOut "wslpath -a '$($env:TROPA_ARCHIVE -replace '\\', '/')'"
    $envs += " TROPA_ARCHIVE='$p'"
}
Say 'Installing tropa inside WSL...'
$rc = InWsl "curl -fsSL https://raw.githubusercontent.com/$Repo/main/install.sh -o /tmp/tropa-install.sh && $envs bash /tmp/tropa-install.sh; r=`$?; rm -f /tmp/tropa-install.sh; exit `$r"
if ($rc -ne 0) { Fail 'The tropa installer failed inside WSL (see above).' }
$ver = InWslOut 'tropa version 2>/dev/null || ~/.local/bin/tropa version'
Ok $ver

# ---- 5. Windows command that forwards to WSL
if ($env:TROPA_NO_SHIM -ne '1') {
    $bin = Join-Path $env:LOCALAPPDATA 'tropa\bin'
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
        Ok "Added $bin to your PATH (new terminals pick it up)"
    }
    Ok 'The tropa command works from PowerShell and CMD too (it runs in WSL)'
}

$home_ = InWslOut 'echo $HOME'
Say ''
Say 'Done. Next steps:'
Say "  1. Open the '$($script:Distro)' app (or run: wsl) and install at least one agent CLI there, for example:"
Say '       curl -fsSL https://claude.ai/install.sh | bash        # Claude Code'
Say '       npm install -g @openai/codex                           # Codex (needs Node)'
Say '       curl -fsSL https://opencode.ai/install | bash          # OpenCode'
Say '       npm install -g @qwen-code/qwen-code                    # Qwen Code (needs Node)'
Say '     Then run each one once to sign in.'
Say '  2. Start the chat:      tropa server up -p 8888'
Say '  3. Open it in your Windows browser:  http://localhost:8888'
Say "  4. Projects live in WSL at ~/projects; in File Explorer: \\wsl.localhost\$($script:Distro)$($home_ -replace '/', '\')\projects"
Say '  Keep projects inside WSL (not on C:) - it is much faster and file watching works.'
Say ''
