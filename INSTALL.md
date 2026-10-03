# Install the Scrappia desktop recorder (Windows, macOS, Linux)

The desktop app is where you build scrapers by clicking: a recorder that drives a real stealth Chromium window, plus a run monitor, exports, settings and the Copilot. This guide installs it on your own computer. It also shows how to send the recipes you build to a Scrappia server set up with [DEPLOY.md](DEPLOY.md), so they run there on a schedule, around the clock.

## At a glance

| | |
| --- | --- |
| What you install | The Scrappia repository, built locally, and started with Electron 44 |
| Prebuilt installer | **None published.** GitHub Releases for `cyberkyd01/Scrappia` is empty, so you run it from source (below). |
| Program folder | Wherever you clone it, e.g. `C:\Users\<you>\Scrappia` or `~/Scrappia` |
| Your recipes, runs, exports, logins | Windows `%APPDATA%\Scrappia\data`, macOS `~/Library/Application Support/Scrappia/data`, Linux `~/.config/Scrappia/data` (Settings > About shows the exact path) |
| Recorder browser | Patchright's Chromium, in the per-user Playwright cache: Windows `%LOCALAPPDATA%\ms-playwright`, macOS `~/Library/Caches/ms-playwright`, Linux `~/.cache/ms-playwright` |
| Admin rights | Only to install Node.js and Git, if you don't have them. Scrappia itself installs per user and changes no system settings. |

## Requirements

- **Windows 10 or 11** (x64), **macOS 12 Monterey or newer** (Apple silicon or Intel), or a **64-bit Linux desktop** (e.g. Ubuntu 22.04+, Debian 12+, Fedora 38+).
- **Node.js 22.13 or newer.** Node 22 LTS or Node 24 LTS both work. Scrappia uses Node's built-in SQLite, which needs 22.13 or newer.
- **Git**, to download the code and get updates.
- **About 2.5 GB free disk.** Libraries take about 400 MB, the Electron runtime about 250 MB, Chromium about 350 MB, and the rest is your data.
- **Access to the private repository** `github.com/cyberkyd01/Scrappia`. You'll sign in to GitHub when Git asks.
- 8 GB RAM is comfortable, because the recorder runs a full browser next to the app.

---

## Install on Windows (PowerShell)

Open **PowerShell**: press the Windows key, type `powershell`, then press Enter.

**1. Install Node.js and Git** (skip what you already have). Windows asks for administrator approval because both install for all users.

```powershell
winget install --id OpenJS.NodeJS.LTS -e --source winget
winget install --id Git.Git -e --source winget
```

**Close PowerShell and open a new window**, so it sees the new programs, then check them:

```powershell
node --version   # v22.13.0 or newer (v24.x is fine)
git --version
```

> Why the commands below say `npm.cmd` and `npx.cmd`: on a default Windows setup, PowerShell refuses to run `npm.ps1` ("running scripts is disabled on this system"). Calling the `.cmd` versions avoids that without changing your PowerShell execution policy.

**2. Download Scrappia.** Git opens a browser window to sign in to GitHub the first time.

```powershell
git clone https://github.com/cyberkyd01/Scrappia.git "$HOME\Scrappia"
Set-Location "$HOME\Scrappia"
```

**3. Install and build.** This takes 3–10 minutes, mostly downloads.

```powershell
npm.cmd ci --no-audit --no-fund
npx.cmd --no install-electron
npx.cmd patchright install chromium
npm.cmd run build
```

What each line does:

1. installs the libraries and links Scrappia's packages;
2. downloads the Electron runtime;
3. downloads the stealth Chromium the recorder uses;
4. compiles everything.

**Run line 2 at least once.** Electron 44 no longer downloads itself during `npm ci`, and the app can't start without it.

**4. Start the app:**

```powershell
npx.cmd electron apps\desktop
```

A window titled **Scrappia** opens. From now on you can also double-click **`Start Scrappia.cmd`** in the Scrappia folder. For a desktop icon, right-click that file, choose **Send to → Desktop (create shortcut)**.

---

## Install on macOS

Open **Terminal** (Applications → Utilities).

**1. Install Git and Node.js** (skip what you have). `xcode-select` installs Apple's command-line tools, which include Git, and shows a dialog. nvm installs Node in your home folder, so you don't need an administrator password.

```bash
xcode-select --install
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Close Terminal and open a new window, then:

```bash
nvm install 22
node --version   # v22.13.0 or newer
```

Prefer the regular installer? Download the **LTS** `.pkg` from <https://nodejs.org> instead of using nvm. It asks for your administrator password.

**2. Download, install and build** (3–10 minutes):

```bash
git clone https://github.com/cyberkyd01/Scrappia.git ~/Scrappia
cd ~/Scrappia
npm ci --no-audit --no-fund
npx --no install-electron
npx patchright install chromium
npm run build
```

Git asks for your GitHub username and a **personal access token** as the password (create one at <https://github.com/settings/tokens>). If you have the GitHub CLI, `gh auth login` sets this up for you.

**3. Start the app:**

```bash
cd ~/Scrappia && npx electron apps/desktop
```

---

## Install on Linux (desktop)

**1. Install Git and Node.js.** Git comes from your distribution, which needs `sudo`. Node comes from nvm, in your home folder, with no `sudo`.

```bash
sudo apt-get install -y git curl          # Fedora: sudo dnf install -y git curl
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Open a new terminal, then:

```bash
nvm install 22
node --version   # v22.13.0 or newer
```

**2. Download, install and build:**

```bash
git clone https://github.com/cyberkyd01/Scrappia.git ~/Scrappia
cd ~/Scrappia
npm ci --no-audit --no-fund
npx --no install-electron
npx patchright install chromium
npm run build
```

**3. Start the app:**

```bash
cd ~/Scrappia && npx electron apps/desktop
```

If the window doesn't open on Ubuntu 23.10 or newer, or the recorder browser doesn't start, see [Troubleshooting](#troubleshooting). Two fixes there need `sudo`: the Electron sandbox helper, and Chromium's system libraries.

---

## First run and configuration

1. **Try it:** click **Templates → Books to Scrape → Use → Run**. Rows appear in the run monitor; click **Open file** when it finishes. The [Getting started guide](docs/guides/getting-started.md) walks you through building your own recipe.
2. **Settings → Browsers** shows whether Chromium is installed. *Install Chromium* there runs `npx patchright install chromium`; it needs Node on your PATH.
3. **Settings → AI providers** (optional) enables the Copilot and AI features. Add Anthropic, any OpenAI-compatible endpoint, or a local Ollama / LM Studio.
4. **Settings → Defaults → Output directory** is where exports with relative paths go (default: the data folder).

The desktop app keeps its own data. It doesn't share recipes with the `scrappia` CLI's `~/.scrappia` folder or with a server.

## Send recipes to your server

The desktop app has no "connect to server" setting; the code has no remote mode. You move recipes as JSON files over the server's REST API. You need the server URL and an API key with `write` scope. On the server, create one with `sudo /opt/scrappia/bin/scrappia api-key create laptop --scopes read,write` (see [DEPLOY.md](DEPLOY.md), step 12).

**1. Export the recipe.** In the recorder, click **Save**, then **Export JSON**, and save e.g. `books.json`. The export contains no passwords or API keys, only the names of secrets.

**2. Upload it.**

Windows (PowerShell):

```powershell
$Server = "https://scrape.example.com"
$Key    = "sk_paste_your_key_here"
$Body   = [System.Text.Encoding]::UTF8.GetBytes((Get-Content -Raw "$HOME\Documents\books.json"))
$Res    = Invoke-RestMethod -Method Post -Uri "$Server/api/recipes" -Headers @{ Authorization = "Bearer $Key" } -ContentType "application/json" -Body $Body
$Res.recipe.id    # note this id
```

macOS / Linux:

```bash
SERVER=https://scrape.example.com
KEY=sk_paste_your_key_here
curl -fsS -X POST "$SERVER/api/recipes" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' --data-binary @books.json
```

The answer contains `"recipe":{"id":"…"}`; note that id. Every upload creates a new recipe, because the export carries no id. To **update** a recipe already on the server, export again and send it with `PUT` to that id:

```bash
curl -fsS -X PUT "$SERVER/api/recipes/RECIPE_ID" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' --data-binary @books.json
```

In PowerShell, the same with `-Method Put -Uri "$Server/api/recipes/RECIPE_ID"`.

**3. Run it, or let it run on schedule.** If the recipe has a **Schedule** (recipe settings), the server picks it up within 30 seconds and runs it around the clock. Turn the schedule off in your local copy, or close the app, so it doesn't also run on your computer. To start a run now:

```bash
curl -fsS -X POST "$SERVER/api/recipes/RECIPE_ID/run" -H "Authorization: Bearer $KEY"
```

**4. Get the data.**

- Rows of the latest successful run (the "dataset as an API"): `GET $SERVER/api/recipes/RECIPE_ID/dataset/latest`.
- Rows of one run: `GET /api/runs/RUN_ID/rows`.
- Exports configured in the recipe with a relative path are written on the server under `/opt/scrappia/shared/data`.

The [API guide](docs/guides/api-guide.md) covers formats and integrations.

**Logins and secrets.** The recorder's logged-in session (cookies) stays on your computer. For sites that need a login, record the login as actions. Type the password from a secret, as described in the [User guide](docs/guides/user-guide.md) under "Sites that need a login". Then store that secret on the server:

```bash
curl -fsS -X PUT "$SERVER/api/secrets/SITE_PASSWORD" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"value":"the-password"}'
```

**AI on the server.** AI providers configured on your desktop are not copied. Set them on the server, either in its `.env` (DEPLOY.md, step 7) or through `PUT /api/settings`.

**AI agents.** To let Claude Code or another MCP client on your computer drive the server, see DEPLOY.md, step 13.

## Updating

Close the app first.

```bash
cd ~/Scrappia            # Windows: Set-Location "$HOME\Scrappia"
git pull
npm ci --no-audit --no-fund
npx --no install-electron
npx patchright install chromium
npm run build
```

On Windows, use `npm.cmd` / `npx.cmd` as in the install section. The last three commands finish quickly when nothing changed; `install-electron` and `patchright install` only download when the versions changed. Your recipes and runs live in the data folder and are kept.

## Uninstall

This removes only what this guide installed.

1. Delete the program folder: `~/Scrappia`, or `C:\Users\<you>\Scrappia`.
2. Delete your data **only if you no longer need your recipes and results**. Export the recipes first if unsure.
   - Windows: `%APPDATA%\Scrappia`
   - macOS: `~/Library/Application Support/Scrappia`
   - Linux: `~/.config/Scrappia`
   - Also `~/.scrappia` if you used the CLI.
3. Delete downloaded runtimes:
   - The Electron download cache: Windows `%LOCALAPPDATA%\electron\Cache`, macOS `~/Library/Caches/electron`, Linux `~/.cache/electron`.
   - The `chromium-*` folders in the Playwright cache listed under [At a glance](#at-a-glance). Do this **only if no other Playwright-based tool on this computer uses them**, because that cache is shared.
4. Uninstall Node.js and Git only if you installed them just for Scrappia and nothing else uses them. Windows: `winget uninstall OpenJS.NodeJS.LTS` and `winget uninstall Git.Git`. nvm: `nvm uninstall 22`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| PowerShell: `npm.ps1 cannot be loaded because running scripts is disabled` | Default execution policy | Use `npm.cmd` / `npx.cmd`, as written above. |
| `npx electron apps/desktop` prints `Downloading Electron binary...` or `Electron failed to install correctly` | Electron runtime not downloaded yet | Run `npx --no install-electron` (Windows: `npx.cmd --no install-electron`). If it still fails, delete `node_modules/electron` and run `npm ci` again. |
| `Start Scrappia.cmd` on a fresh copy runs setup, then fails with "Windows cannot find … electron.exe" | It checks for `electron.exe`, which only exists after `install-electron` | Run the four commands of step 3 once; after that the shortcut works. |
| The app starts as plain Node, or prints Node errors instead of opening a window | `ELECTRON_RUN_AS_NODE` is set in your terminal (some IDE terminals set it) | Windows: `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`. macOS/Linux: `unset ELECTRON_RUN_AS_NODE`. Then start again. |
| Recorder: "Executable doesn't exist" / browser doesn't open | Chromium not installed | `npx patchright install chromium` (or Settings → Browsers → Install Chromium). |
| Recorder overlay stays at "overlay loading…" | The inspector package wasn't built | `npm run build` again, then reload the page. |
| Linux: `The SUID sandbox helper binary was found, but is not configured correctly` | Ubuntu 23.10+ restricts unprivileged user namespaces, so Electron needs its sandbox helper to be setuid root | `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`. This changes only that one file inside your Scrappia folder. |
| Linux: recorder browser fails with `error while loading shared libraries` | Chromium system libraries missing | Debian/Ubuntu: `sudo env "PATH=$PATH" npx patchright install-deps chromium`. It installs the libraries with apt and needs admin rights. Other distributions: install the library named in the error with your package manager. |
| `git clone` asks for a password and then fails | GitHub no longer accepts account passwords for Git | Use the browser sign-in (Windows), a personal access token, or `gh auth login`. |
| `node:sqlite` errors | Node older than 22.13 | `node --version`; install Node 22 LTS or newer. |
| Upload to server: `401` | Wrong key, or the key lacks `write` scope | Create a `read,write` key on the server (DEPLOY.md, step 12). |
| Upload to server: `400 invalid_recipe` | Validation error | The response lists each problem with its JSON path. Fix it in the recorder and export again. |

Making a stand-alone installer (`npm run package --prefix apps/desktop`, electron-builder) isn't covered by this guide. Electron is declared as a version range, so electron-builder needs the exact version passed explicitly (`-- -c.electronVersion=<version from node_modules/electron/package.json>`). That path wasn't verified, so use the run-from-source setup above.

More help: [docs/guides/troubleshooting.md](docs/guides/troubleshooting.md).
