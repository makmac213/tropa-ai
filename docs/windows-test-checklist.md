# Windows test checklist

`install.ps1` was tested on Linux with PowerShell 7 and a stand-in `wsl.exe`. These steps cover what only a real Windows PC can show. Note anything that differs.

## Install
- [ ] **Windows PowerShell 5.1** (the built-in one, not PowerShell 7): `irm https://raw.githubusercontent.com/makmac213/tropa-ai/main/install.ps1 | iex`
- [ ] **No WSL yet:** it offers to install Ubuntu. After the restart and creating the Ubuntu user, running it again carries on.
- [ ] **Ubuntu already there:** it detects "WSL 2 distribution: Ubuntu". Try a non-English Windows display language too, if you can.
- [ ] **Missing packages:** sudo asks for the Linux password in the same window, and apt shows its progress.
- [ ] **No Docker and no Node:** answering yes installs Node 22, and `node -v` in Ubuntu shows v22.x.
- [ ] **A user name with a space** (`C:\Users\Jane Doe\...`): the temporary script paths still work.
- [ ] **Re-running the installer** is harmless: it updates tropa and doesn't add a second PATH entry.

## Windows `tropa` command
- [ ] In a **new** PowerShell window, `tropa version` prints the version.
- [ ] `tropa server up -p 8888` works from PowerShell, and http://localhost:8888 opens in Edge or Chrome.
- [ ] From `C:\Users\<you>`, `tropa doctor` runs (from a folder that isn't a tropa project it should say so).
- [ ] From CMD with arguments in quotes, `tropa init -n "demo"` arrives correctly.

## Inside Ubuntu
- [ ] Install Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`) and sign in. The browser sign-in hands off from WSL.
- [ ] Create a project from the chat. It lands in `~/projects/<name>` and the team starts (`tmux attach -t ai-<name>`).
- [ ] The ▦ Team view shows the agents' screens, and approvals from the chat work.
- [ ] `tropa init` inside `/mnt/c/...` prints the Windows-drive warning, and `tropa doctor` shows the WSL line.
- [ ] Read aloud: with Docker Desktop (WSL integration on) Kokoro speaks; without it, ⚙ Settings → System voices uses Windows voices.
- [ ] Optional: ngrok inside Ubuntu, then 🌐 Share for a dev server, opened on a phone.
