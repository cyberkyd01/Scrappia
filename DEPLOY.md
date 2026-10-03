# Deploy Scrappia on a VPS (over SSH)

At the end of this guide, the Scrappia server runs on your own Ubuntu/Debian server: the REST API with its built-in scheduler, the headless scraping engine with stealth Chromium, and the MCP server for AI agents. It sits behind nginx with a free Let's Encrypt certificate:

- API at `https://your-domain/api/...`, with docs at `https://your-domain/docs`
- MCP endpoint at `https://your-domain/mcp`

If you don't have a domain, it can run at `http://SERVER-IP:8111` instead.

The guide is written for a server that **already hosts other things**. Everything it creates is named `scrappia` and lives in its own folders. Node.js and Chromium are private copies, and memory caps keep runaway browsers from hurting your other apps.

> The **desktop recorder** (point-and-click recipe builder) runs on your own computer, not on the server. To install it and send recipes to this server, see **[INSTALL.md](INSTALL.md)**.

## At a glance

| | |
| --- | --- |
| Install directory | `/opt/scrappia` (code in `releases/`, live version at `current`, data in `shared/data`) |
| Settings | `/etc/scrappia/deploy.conf` (non-secret; the only file you edit) and `/opt/scrappia/shared/.env` (secrets, mode 600) |
| System user | `scrappia` (no login shell) |
| Services | `scrappia.service`: REST API + scheduler + headless engine on `127.0.0.1:3111`<br>`scrappia-mcp.service`: MCP server (Streamable HTTP) on `127.0.0.1:3211` |
| Public URLs | `https://DOMAIN/` (API, `/docs`, `/health`) and `https://DOMAIN/mcp` (MCP), or `http://SERVER-IP:8111` |
| Runtime | Node.js 22 (private copy in `/opt/scrappia/runtime/node`) |
| Browser | Patchright's Chromium in `/opt/scrappia/browsers` (`PLAYWRIGHT_BROWSERS_PATH`) |
| Database | SQLite (Node's built-in `node:sqlite`): `/opt/scrappia/shared/data/scrappia.db`. Exports, browser profiles and screenshots sit next to it. No PostgreSQL or Redis needed. |
| Server CLI | `sudo /opt/scrappia/bin/scrappia …` (API keys, test runs, against the server's data) |
| Never touched | System Node/npm, any other Playwright/Chrome install, other nginx sites, `nginx.conf`, the `default` site, firewall policy, other apps' ports |

## Requirements

- **Server:** Ubuntu 22.04 or 24.04 LTS, or Debian 12, on x86_64 or arm64.
- **Size:**
  - HTTP-mode scraping only: 1 vCPU, 2 GB RAM.
  - Browser mode (JavaScript sites, logins, infinite scroll): at least 2 vCPU and 4 GB RAM. Each Chromium instance uses about 200–300 MB. See [Memory and concurrency](#memory-and-concurrency).
  - Disk: 6 GB free plus room for your data. The code, dependencies and Chromium take about 1.5 GB, and 3 releases are kept.
  - The build peaks at about 600 MB RAM, so add swap in step 3b on servers with less than 2 GB.
- **Access:** SSH as root or as a user with `sudo`. Minimal Debian logged in as root: run `apt-get install -y sudo` first.
- **Domain (strongly recommended):** a DNS **A record** for e.g. `scrape.example.com` pointing at the server's IPv4 address. API keys and the MCP token are sent with every request, so use HTTPS for anything reachable from the internet. If you use Cloudflare, set the record to **DNS only** (grey cloud) while you get the certificate.
- **Optional:** an AI provider key (Anthropic, OpenAI or a local Ollama) for the Copilot, recipe generation and self-healing selectors. Proxy and CAPTCHA-service accounts are also optional.

---

## 1. Connect and set your variables

```bash
ssh root@YOUR_SERVER_IP        # or: ssh youruser@YOUR_SERVER_IP
```

Edit `DOMAIN` and `EMAIL` in the block before you paste it; leave `DOMAIN` empty to run on the server IP. Every later block reads this file, so you set values in one place, and a dropped SSH session doesn't lose anything.

```bash
sudo mkdir -p /etc/scrappia
sudo tee /etc/scrappia/deploy.conf >/dev/null <<'CONF'
# Scrappia deployment settings. Every step of DEPLOY.md reads this file.
APP=scrappia
APP_USER=scrappia
APP_HOME=/opt/scrappia
REPO_URL=git@github.com:cyberkyd01/Scrappia.git
BRANCH=main
PORT=3111            # REST API on 127.0.0.1:PORT (never public)
MCP_PORT=3211        # MCP server on 127.0.0.1:MCP_PORT (never public; published at /mcp)
PUBLIC_PORT=8111     # used only when DOMAIN is empty: http://SERVER-IP:PUBLIC_PORT
DOMAIN=              # e.g. scrape.example.com (leave empty to run on the server IP)
EMAIL=               # your email, for Let's Encrypt expiry notices (needed when DOMAIN is set)
NODE_MAJOR=22
MEMORY_MAX=2G        # hard RAM cap for the API service and its browsers (see "Memory and concurrency")
MCP_MEMORY_MAX=1G    # hard RAM cap for the MCP service and its browsers
CONF
sudo chmod 644 /etc/scrappia/deploy.conf
cat /etc/scrappia/deploy.conf
```

To change something later, run `sudo nano /etc/scrappia/deploy.conf`. Pasting the block again resets the file to the values in the block. [Changing settings later](#changing-settings-later) lists which steps to re-run after each kind of change.

## 2. Preflight checks

This step only reads; it changes nothing. Every line should start with `OK`. A `STOP` line means fix that first; `WARN` is for information.

```bash
sudo bash <<'EOF'
source /etc/scrappia/deploy.conf
. /etc/os-release
echo "System: $PRETTY_NAME, $(uname -m)"
case "$ID:$VERSION_ID" in
  ubuntu:22.04|ubuntu:24.04|debian:12) echo "OK    supported OS" ;;
  *) echo "STOP  unsupported OS: step 3 knows the Chromium libraries for Ubuntu 22.04/24.04 and Debian 12 only" ;;
esac
case "$(uname -m)" in x86_64|aarch64) echo "OK    CPU architecture" ;; *) echo "STOP  unsupported CPU $(uname -m)" ;; esac
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -ge 3500 ]; then echo "OK    RAM ${MEM_MB} MB"
elif [ $((MEM_MB + SWAP_MB)) -ge 1800 ]; then echo "WARN  RAM ${MEM_MB} MB (+${SWAP_MB} MB swap): fine for HTTP mode; keep browser concurrency low (see Memory and concurrency)"
else echo "WARN  only ${MEM_MB} MB RAM + ${SWAP_MB} MB swap: do step 3b (swap) before building"; fi
DISK_MB=$(df -Pm / | awk 'NR==2 {print $4}')
if [ "$DISK_MB" -ge 6144 ]; then echo "OK    ${DISK_MB} MB free disk"; else echo "STOP  only ${DISK_MB} MB free disk (need 6 GB)"; fi
owner() { ss -ltnpH "sport = :$1" | grep -oE 'users:\(\("[^"]+"' | cut -d'"' -f2 | sort -u | tr '\n' ' '; }
for pair in "PORT:$PORT:scrappia" "MCP_PORT:$MCP_PORT:scrappia-mcp"; do
  name=${pair%%:*}; rest=${pair#*:}; p=${rest%%:*}; unit=${rest#*:}
  if [ -z "$(ss -ltnH "sport = :$p")" ]; then echo "OK    port $p ($name) is free"
  elif systemctl is-active --quiet "$unit"; then echo "OK    port $p is used by $unit itself (re-run)"
  else echo "STOP  port $p is used by: $(owner "$p"). Set $name to a free port in /etc/scrappia/deploy.conf"; fi
done
if [ -z "$DOMAIN" ]; then
  if [ -z "$(ss -ltnH "sport = :$PUBLIC_PORT")" ]; then echo "OK    public port $PUBLIC_PORT is free (no-domain mode)"
  elif grep -qs "listen $PUBLIC_PORT" /etc/nginx/sites-available/scrappia /etc/nginx/conf.d/scrappia.conf; then echo "OK    public port $PUBLIC_PORT is already this app's nginx site (re-run)"
  else echo "STOP  public port $PUBLIC_PORT is used by: $(owner "$PUBLIC_PORT"). Set PUBLIC_PORT to a free port in deploy.conf"; fi
fi
WEB=$(ss -ltnpH '( sport = :80 or sport = :443 )' | grep -oE 'users:\(\("[^"]+"' | cut -d'"' -f2 | sort -u | tr '\n' ' ')
case "$WEB" in
  "") echo "OK    ports 80/443 are free: nginx will be installed in step 11" ;;
  "nginx ") echo "OK    nginx serves 80/443: a separate scrappia site will be added" ;;
  *) echo "STOP  ports 80/443 belong to: $WEB. Do not install nginx; in step 11 use the Appendix (Caddy/Apache)" ;;
esac
if [ -n "$DOMAIN" ]; then
  [ -n "$EMAIL" ] && echo "OK    EMAIL is set" || echo "STOP  EMAIL is empty in deploy.conf (Let's Encrypt needs it)"
  SERVER_IP=$(curl -4fsS --max-time 10 https://api.ipify.org || echo unknown)
  DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')
  if [ -n "$DNS_IP" ] && [ "$DNS_IP" = "$SERVER_IP" ]; then echo "OK    $DOMAIN points at this server ($SERVER_IP)"
  else echo "WARN  $DOMAIN resolves to '${DNS_IP:-nothing}', this server is $SERVER_IP. Fix the A record before step 11b (it can propagate meanwhile)"; fi
else
  echo "WARN  no DOMAIN set: no-domain mode (http://SERVER-IP:$PUBLIC_PORT). API keys would travel unencrypted."
fi
EOF
```

## 3. Install system packages

This step only adds packages; nothing is upgraded or removed.

**About the browser libraries.** Patchright can install Chromium's system libraries itself (`patchright install-deps chromium`). That also pulls in `xvfb`, a virtual X server that headless scraping doesn't use, plus about a dozen font packages. This block installs the exact Chromium library list from Patchright 1.63 for your distribution, plus a small font set: Liberation (Arial/Times-compatible metrics), FreeFont and colour emoji. The libraries are shared system libraries that any program may use; no browser or daemon is installed. Chromium itself is downloaded into `/opt/scrappia/browsers` during the deploy (step 10), not system-wide.

```bash
sudo bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1   # additive only: needrestart must not restart other services
source /etc/scrappia/deploy.conf
. /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:24.04) LIBS="libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2" ;;
  ubuntu:22.04) LIBS="libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libwayland-client0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2" ;;
  debian:12)    LIBS="libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2" ;;
  *) echo "STOP: unsupported OS $ID $VERSION_ID"; exit 1 ;;
esac
FONTS="fontconfig fonts-liberation fonts-freefont-ttf fonts-noto-color-emoji"
export DEBIAN_FRONTEND=noninteractive
apt-get update
MISSING_PKGS=""; for p in ca-certificates curl git openssh-client xz-utils openssl $LIBS $FONTS; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'ok installed' || MISSING_PKGS="$MISSING_PKGS $p"; done
if [ -n "$MISSING_PKGS" ]; then apt-get install -y --no-install-recommends $MISSING_PKGS </dev/null; fi   # only what's missing - never upgrades installed packages
echo "OK: packages installed"
EOF
```

**Optional: CJK and Thai fonts.** If screenshots of Chinese, Japanese, Korean or Thai pages show empty boxes, add these fonts. Patchright's own list includes them, and it's about 40 MB:

```bash
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get install -y --no-install-recommends fonts-wqy-zenhei fonts-ipafont-gothic fonts-tlwg-loma-otf fonts-unifont
```

### 3b. Optional: add swap (servers with less than 2 GB RAM)

This does nothing if the server already has swap.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/scrappia/deploy.conf
if [ -n "$(swapon --show --noheadings)" ]; then echo "Swap already active, nothing to do"; exit 0; fi
fallocate -l 2G /swapfile-scrappia 2>/dev/null || dd if=/dev/zero of=/swapfile-scrappia bs=1M count=2048 status=none
chmod 600 /swapfile-scrappia
mkswap /swapfile-scrappia >/dev/null
swapon /swapfile-scrappia
grep -q '^/swapfile-scrappia ' /etc/fstab || echo '/swapfile-scrappia none swap sw 0 0' >> /etc/fstab
swapon --show
EOF
```

## 4. Create the app user and folders

The `scrappia` user owns only what it writes to. The top folder, `bin/` (the deploy script and the CLI wrappers, which run as root) and the Node runtime stay owned by root, so the service user can't change anything root executes. The services get `/opt/scrappia/home` as `HOME`, which is where Chromium keeps its font cache and certificate store.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/scrappia/deploy.conf
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
install -d -o root -g "$APP_USER" -m 750 "$APP_HOME"
install -d -o root -g root -m 755 "$APP_HOME/bin" "$APP_HOME/runtime"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_HOME/releases" "$APP_HOME/repo" "$APP_HOME/browsers" "$APP_HOME/home" "$APP_HOME/shared"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_HOME/.ssh" "$APP_HOME/shared/data" "$APP_HOME/backups"
install -d -o root -g root -m 755 /etc/scrappia
ls -la "$APP_HOME"
EOF
```

## 5. Install the runtime (isolated)

This downloads the official Node.js 22 build into `/opt/scrappia/runtime/node` and verifies its SHA-256. Scrappia needs Node 22.13 or newer for the built-in SQLite, and the latest 22.x always qualifies. No system Node, nvm or other Node install is touched. If Node 22 is already present, the download is skipped.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/scrappia/deploy.conf
if "$APP_HOME/runtime/node/bin/node" -v 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  echo "Node $("$APP_HOME/runtime/node/bin/node" -v) already installed"; exit 0
fi
case "$(uname -m)" in x86_64) NARCH=x64 ;; aarch64|arm64) NARCH=arm64 ;; *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;; esac
BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
TARBALL="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep -oE "node-v[0-9.]+-linux-${NARCH}\.tar\.xz" | head -1)"
TMP="$(mktemp -d)"
curl -fsSL "$BASE/$TARBALL" -o "$TMP/$TARBALL"
(cd "$TMP" && curl -fsSL "$BASE/SHASUMS256.txt" | grep " $TARBALL\$" | sha256sum -c -)
rm -rf "$APP_HOME/runtime/node" && mkdir -p "$APP_HOME/runtime/node"
tar -xJf "$TMP/$TARBALL" -C "$APP_HOME/runtime/node" --strip-components=1
rm -rf "$TMP"
chown -R root:root "$APP_HOME/runtime"
"$APP_HOME/runtime/node/bin/node" -v
"$APP_HOME/runtime/node/bin/npm" -v
EOF
```

You should see `v22.x.x` (x ≥ 13) and an npm version.

## 6. Give the server read access to the repo

The repository is private, so the server needs a **read-only deploy key**.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/scrappia/deploy.conf
KEY="$APP_HOME/.ssh/id_ed25519"
[ -f "$KEY" ] || sudo -u "$APP_USER" ssh-keygen -q -t ed25519 -N '' -C "$APP@$(hostname)" -f "$KEY" </dev/null
sudo -u "$APP_USER" touch "$APP_HOME/.ssh/known_hosts"
if ! grep -q '^github.com ssh-ed25519' "$APP_HOME/.ssh/known_hosts"; then
  ssh-keyscan -t ed25519 github.com 2>/dev/null | sudo -u "$APP_USER" tee -a "$APP_HOME/.ssh/known_hosts" >/dev/null
fi
echo
echo "Copy the line below and paste it at https://github.com/cyberkyd01/Scrappia/settings/keys/new"
echo "Title: $APP@$(hostname). Leave 'Allow write access' UNTICKED."
echo
cat "$KEY.pub"
EOF
```

After saving the key on GitHub, test it:

```bash
sudo bash <<'EOF'
source /etc/scrappia/deploy.conf
OUT=$(sudo -u "$APP_USER" -H ssh -T -o BatchMode=yes git@github.com </dev/null 2>&1)
case "$OUT" in
  *"successfully authenticated"*) echo "OK    GitHub accepts the deploy key" ;;
  *) echo "STOP  GitHub refused the key: $OUT" ;;
esac
EOF
```

You should see `OK    GitHub accepts the deploy key`. If the repository is public, skip this step and set `REPO_URL=https://github.com/cyberkyd01/Scrappia.git` in `deploy.conf` instead.

## 7. Configure the app (.env)

The server reads its settings from environment variables only. It has no `.env` loader of its own, so systemd loads `/opt/scrappia/shared/.env` into both services (`EnvironmentFile=`). Format: one `KEY=value` per line, no quotes, no `export`, no `${…}`. The block creates the file **only if it doesn't exist yet**, so the MCP token is never regenerated by a re-run.

You don't need a bootstrap `SCRAPPIA_API_KEY`. You'll create the first real API key directly on the server in step 12. Until a key exists, the API refuses every request that comes through nginx.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/scrappia/deploy.conf
ENV="$APP_HOME/shared/.env"
if [ -s "$ENV" ]; then
  echo ".env already exists: keeping it (the MCP token is never regenerated)"
else
  umask 077
  cat > "$ENV" <<ENVFILE
# Scrappia settings, loaded by systemd: KEY=value per line, no quotes, no "export", no \${...}.
# Restart after editing:  sudo systemctl restart scrappia scrappia-mcp
# PORT, HOST, SCRAPPIA_HOME, PLAYWRIGHT_BROWSERS_PATH, HOME and NODE_ENV come from the systemd units
# (step 9, from /etc/scrappia/deploy.conf). Do not set them here: this file would override the units.
# To use a default, comment a line out. Do not leave a value empty.

# Bearer token for the MCP endpoint (https://DOMAIN/mcp). Generated once.
SCRAPPIA_MCP_TOKEN=$(openssl rand -hex 32)

# Logging and API limits
SCRAPPIA_LOG_LEVEL=info
# SCRAPPIA_LOG_JSON=1
SCRAPPIA_RATE_LIMIT=600
# SCRAPPIA_CORS=https://app.example.com
# SCRAPPIA_NO_SCHEDULER=1

# AI providers (optional). Picked up automatically when none are configured through the API/CLI.
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# OLLAMA_HOST=http://127.0.0.1:11434
# SCRAPPIA_AI_MODEL=model-name

# Bootstrap API key: not needed. Create keys with: sudo /opt/scrappia/bin/scrappia api-key create <name> --scopes admin
# SCRAPPIA_API_KEY=
ENVFILE
  echo "Created $ENV"
fi
chown "$APP_USER:$APP_USER" "$ENV"
chmod 600 "$ENV"
if grep -q '^SCRAPPIA_MCP_TOKEN=..' "$ENV"; then echo "OK: MCP token present"; else echo "STOP: SCRAPPIA_MCP_TOKEN missing in $ENV"; fi
EOF
```

Every variable the code reads:

| Variable | Where | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | unit (from `deploy.conf`) | REST API listen port and address: `3111` on `127.0.0.1`. |
| `SCRAPPIA_HOME` | unit | Data folder: `/opt/scrappia/shared/data` (database `scrappia.db`, exports, browser profiles, screenshots). |
| `PLAYWRIGHT_BROWSERS_PATH` | unit | `/opt/scrappia/browsers`, the private Chromium. |
| `SCRAPPIA_MCP_TOKEN` | `.env` | **Required for MCP over the internet.** Clients send `Authorization: Bearer <token>`. Without it the MCP endpoint is open. |
| `SCRAPPIA_API_KEY` | `.env`, optional | Bootstrap key, accepted only while no API keys exist. Not needed with this guide. |
| `SCRAPPIA_RATE_LIMIT` | `.env` | Requests per minute per API key (default 600). `0` turns limiting off, and so does an empty value, so don't leave it empty. |
| `SCRAPPIA_CORS` | `.env`, optional | Browser origins allowed to call the API (`*` or a comma-separated list). Unset means no CORS headers. |
| `SCRAPPIA_LOG_LEVEL` | `.env` | `debug`, `info`, `warn` or `error`. |
| `SCRAPPIA_LOG_JSON` | `.env`, optional | `1` = one JSON object per log line. |
| `SCRAPPIA_NO_SCHEDULER` | `.env`, optional | `1` = don't run cron schedules in this process. Leave unset, because the API service is the one that runs schedules. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_HOST`, `SCRAPPIA_OLLAMA`, `SCRAPPIA_AI_MODEL` | `.env`, optional | AI providers auto-detected when none are configured through the API (`PUT /api/settings`) or `scrappia ai add`. Don't leave `SCRAPPIA_AI_MODEL` empty; comment it out instead. |
| Any secret name used by a recipe | `.env` or `PUT /api/secrets/<name>` | Recipes reference secrets by name. The server looks in its secret store first, then in the environment. |

## 8. Database

Nothing to set up. The SQLite database `/opt/scrappia/shared/data/scrappia.db` is created on first start, and the schema updates itself whenever the service starts. The database file also holds API key hashes, recipe secrets and AI settings in plain form, so the data folder is `700` and owned by `scrappia`.

## 9. Run it as a service (systemd)

Two units are created and enabled here; the first deploy in step 10 starts them.

- **`scrappia.service`** runs the REST API, the cron scheduler (it picks up schedule changes every 30 seconds) and the scraping engine, including the headless browsers. `MemoryMax=$MEMORY_MAX` caps the service **together with every Chromium it starts**, so a heavy scrape can't push your other apps into swap or the OOM killer. `KillMode=mixed` lets the server cancel runs and close its browsers on stop; it gives them 15 seconds.
- **`scrappia-mcp.service`** runs the MCP server over Streamable HTTP on `127.0.0.1:$MCP_PORT/mcp`, with the bearer token from `.env`. It shares the database with the API service. Runs that an agent starts execute **in this process**, under `MCP_MEMORY_MAX`. If you don't use AI agents, you can switch it off at any time: `sudo systemctl disable --now scrappia-mcp`. `deploy.sh` only restarts enabled units.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/scrappia/deploy.conf
COMMON="User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_HOME/current
EnvironmentFile=$APP_HOME/shared/.env
Environment=NODE_ENV=production
Environment=HOME=$APP_HOME/home
Environment=SCRAPPIA_HOME=$APP_HOME/shared/data
Environment=PLAYWRIGHT_BROWSERS_PATH=$APP_HOME/browsers
Environment=NODE_OPTIONS=--disable-warning=ExperimentalWarning
Environment=PATH=$APP_HOME/runtime/node/bin:/usr/bin:/bin
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$APP_HOME"
cat > /etc/systemd/system/scrappia.service <<UNIT
[Unit]
Description=Scrappia REST API, scheduler and headless engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$COMMON
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
MemoryMax=$MEMORY_MAX
ExecStart=$APP_HOME/runtime/node/bin/node apps/server/dist/index.js

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/scrappia-mcp.service <<UNIT
[Unit]
Description=Scrappia MCP server (Streamable HTTP)
After=network-online.target scrappia.service
Wants=network-online.target

[Service]
Type=simple
$COMMON
MemoryMax=$MCP_MEMORY_MAX
ExecStart=$APP_HOME/runtime/node/bin/node packages/mcp/dist/bin.js --http $MCP_PORT --host 127.0.0.1 --log-level info

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable scrappia.service scrappia-mcp.service
if [ -e "$APP_HOME/current" ]; then
  for s in scrappia scrappia-mcp; do systemctl is-enabled --quiet "$s" && systemctl restart "$s"; done
fi
echo "OK: units installed (API on 127.0.0.1:$PORT, MCP on 127.0.0.1:$MCP_PORT)"
EOF
```

## 10. Create the deploy script and deploy

`/opt/scrappia/bin/deploy.sh` handles the first install and every update. It refuses to run while scrapes are in progress, because a restart cancels them; `--force` overrides that. Then it:

1. fetches the branch into a new folder under `releases/`;
2. installs dependencies with `npm ci --ignore-scripts` (as the repo's Dockerfile does) and links the local packages;
3. builds only the server parts (`packages/core`, `packages/mcp`, `apps/cli`, `apps/server`; the desktop app isn't built), then drops dev dependencies;
4. installs the matching Chromium into `/opt/scrappia/browsers` (a no-op if it's already there) and **test-launches it**, so missing libraries fail the deploy before anything switches;
5. switches `current`, restarts the enabled services and health-checks both; if the check fails, it rolls back automatically.

It also writes two root-owned helper commands:

- `/opt/scrappia/bin/scrappia`: the Scrappia CLI, run as the `scrappia` user against the server's data;
- `/opt/scrappia/bin/scrappia-mcp`: the MCP server over stdio, for SSH-based clients.

```bash
sudo tee /opt/scrappia/bin/deploy.sh >/dev/null <<'DEPLOY'
#!/usr/bin/env bash
# Deploys the latest commit of $BRANCH. First install and every update. Safe to re-run.
# Usage: sudo /opt/scrappia/bin/deploy.sh [--force]    (--force: deploy even while scrapes run; they get cancelled)
set -Eeuo pipefail
source /etc/scrappia/deploy.conf
[ "$(id -u)" -eq 0 ] || { echo "Run with: sudo $0"; exit 1; }

RELEASES="$APP_HOME/releases"; SHARED="$APP_HOME/shared"; REPO="$APP_HOME/repo"
# Root only runs system binaries; the private Node runtime is used as the app user.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
APP_PATH="$APP_HOME/runtime/node/bin:/usr/local/bin:/usr/bin:/bin"
as_app() { sudo -u "$APP_USER" -H env HOME="$APP_HOME/home" PATH="$APP_PATH" PLAYWRIGHT_BROWSERS_PATH="$APP_HOME/browsers" NODE_OPTIONS=--disable-warning=ExperimentalWarning bash -euo pipefail -c "$1"; }

[ -x "$APP_HOME/runtime/node/bin/node" ] || { echo "Node runtime missing: run step 5 of DEPLOY.md"; exit 1; }
[ -s "$SHARED/.env" ] || { echo "$SHARED/.env missing: run step 7 of DEPLOY.md"; exit 1; }
systemctl is-enabled --quiet scrappia || { echo "scrappia.service is not enabled: run step 9 of DEPLOY.md"; exit 1; }
SERVICES=(scrappia); systemctl is-enabled --quiet scrappia-mcp && SERVICES+=(scrappia-mcp)

active_runs() {
  local total=0 n p
  for p in "$PORT" "$MCP_PORT"; do
    n=$(curl -fsS --max-time 5 "http://127.0.0.1:$p/health" 2>/dev/null | grep -o '"activeRuns":[0-9]*' | cut -d: -f2 || true)
    total=$((total + ${n:-0}))
  done
  echo "$total"
}
RUNNING=$(active_runs)
if [ "$RUNNING" -gt 0 ] && [ "${1:-}" != "--force" ]; then
  echo "!! $RUNNING scrape(s) are running. Deploying restarts the services and cancels them." >&2
  echo "   Wait until they finish, or run: sudo $0 --force" >&2
  echo "   (a cancelled run can be resumed later with POST /api/runs/<id>/retry)" >&2
  exit 1
fi

echo "==> Fetching $BRANCH"
if [ ! -d "$REPO/.git" ]; then as_app "git clone --quiet '$REPO_URL' '$REPO'"; fi
as_app "cd '$REPO' && git remote set-url origin '$REPO_URL' && git fetch --quiet --prune origin '$BRANCH' && git reset --quiet --hard 'origin/$BRANCH'"
SHA="$(as_app "cd '$REPO' && git rev-parse --short HEAD")"
NEW="$RELEASES/$(date +%Y%m%d%H%M%S)-$SHA"
trap 'echo "!! Deploy failed before the switch; the running version is untouched" >&2; rm -rf "$NEW"' ERR
as_app "mkdir -p '$NEW' && cd '$REPO' && git archive HEAD | tar -x -C '$NEW'"

echo "==> Installing dependencies and building the server, MCP server and CLI"
as_app "cd '$NEW' && npm ci --ignore-scripts --no-audit --no-fund && node scripts/link-packages.mjs >/dev/null"
as_app "cd '$NEW' && npm run build --prefix packages/core && npm run build --prefix packages/mcp && npm run build --prefix apps/cli && npm run build --prefix apps/server"
as_app "cd '$NEW' && npm prune --omit=dev --ignore-scripts --no-audit --no-fund && node scripts/link-packages.mjs >/dev/null"

echo "==> Installing headless Chromium into $APP_HOME/browsers (skipped when already present)"
as_app "cd '$NEW' && node node_modules/patchright/cli.js install --no-shell chromium"
CHECK='import("patchright").then(async ({ chromium }) => { const b = await chromium.launch({ channel: "chromium", headless: true }); console.log("Chromium OK", b.version()); await b.close(); }).catch((e) => { console.error("Chromium failed to start:", e.message); process.exit(1); })'
as_app "cd '$NEW' && node -e '$CHECK'"
trap - ERR

echo "==> Writing helper commands"
for pair in scrappia:apps/cli/dist/index.js scrappia-mcp:packages/mcp/dist/bin.js; do
  name=${pair%%:*}; entry=${pair#*:}
  cat > "$APP_HOME/bin/$name.new" <<'WRAP'
#!/usr/bin/env bash
# Runs a Scrappia command on this server, as the scrappia user, against the server's data folder.
set -euo pipefail
source /etc/scrappia/deploy.conf
[ "$(id -u)" -eq 0 ] || { echo "Run with: sudo $0 ..." >&2; exit 1; }
cd /
exec sudo -u "$APP_USER" env -i HOME="$APP_HOME/home" PATH="$APP_HOME/runtime/node/bin:/usr/bin:/bin" \
  SCRAPPIA_HOME="$APP_HOME/shared/data" PLAYWRIGHT_BROWSERS_PATH="$APP_HOME/browsers" \
  NODE_OPTIONS=--disable-warning=ExperimentalWarning TERM="${TERM:-dumb}" \
  bash -c 'set -a; . "$0"; set +a; exec node "$@"' "$APP_HOME/shared/.env" "$APP_HOME/current/__ENTRY__" "$@"
WRAP
  sed -i "s|__ENTRY__|$entry|" "$APP_HOME/bin/$name.new"
  chmod 755 "$APP_HOME/bin/$name.new" && mv -f "$APP_HOME/bin/$name.new" "$APP_HOME/bin/$name"
done

echo "==> Switching to $NEW"
PREV="$(readlink -f "$APP_HOME/current" 2>/dev/null || true)"
ln -sfn "$NEW" "$APP_HOME/current.new" && mv -Tf "$APP_HOME/current.new" "$APP_HOME/current"
systemctl restart "${SERVICES[@]}"

healthy() {
  curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/health" || return 1
  if systemctl is-enabled --quiet scrappia-mcp; then curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$MCP_PORT/health" || return 1; fi
}
echo "==> Health check (API :$PORT, MCP :$MCP_PORT)"
for i in $(seq 1 45); do
  if healthy; then
    echo "==> Deployed $SHA"
    ls -1dt "$RELEASES"/*/ | tail -n +4 | xargs -r rm -rf   # keep last 3
    exit 0
  fi
  sleep 2
done
echo "!! Health check failed: rolling back" >&2
journalctl -u scrappia -u scrappia-mcp -n 40 --no-pager >&2 || true
if [ -n "$PREV" ] && [ -d "$PREV" ]; then
  ln -sfn "$PREV" "$APP_HOME/current.new" && mv -Tf "$APP_HOME/current.new" "$APP_HOME/current"
  systemctl restart "${SERVICES[@]}"
  echo "!! Rolled back to $PREV" >&2
fi
exit 1
DEPLOY
sudo chown root:root /opt/scrappia/bin/deploy.sh
sudo chmod 750 /opt/scrappia/bin/deploy.sh
```

Run the first deploy. It takes 3–6 minutes, most of it downloading dependencies and Chromium (about 170 MB):

```bash
sudo /opt/scrappia/bin/deploy.sh
```

It should print `Chromium OK <version>` and end with `==> Deployed <commit>`. Check the services:

```bash
systemctl is-active scrappia scrappia-mcp
```

You should see `active` twice.

## 11. Put it on your domain (nginx + HTTPS)

If the preflight said ports 80/443 belong to Apache, Caddy or something else, **skip this step** and use the [Appendix](#appendix-caddy--apache-instead-of-nginx).

The block adds one nginx site, `scrappia`. It installs nginx only if missing, tests the configuration before reloading, and removes its own site again if the test fails. The site sends `/mcp` to the MCP server and everything else to the REST API.

- `proxy_buffering off` lets the live streams flow: run events, Copilot progress, and MCP responses, which arrive as server-sent events.
- The one-hour timeouts allow long Copilot turns and MCP `run_recipe` calls, which wait for the run.

> Keep the `X-Forwarded-For` header in the config. When no API key exists, the server trusts loopback requests that have no `X-Forwarded-For`. The header is what marks proxied internet traffic as non-local.

```bash
sudo bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1   # additive only: needrestart must not restart other services
source /etc/scrappia/deploy.conf
WEB=$(ss -ltnpH '( sport = :80 or sport = :443 )' | grep -oE 'users:\(\("[^"]+"' | cut -d'"' -f2 | sort -u | tr '\n' ' ')
case "$WEB" in ""|"nginx ") ;; *) echo "STOP: ports 80/443 belong to: $WEB. Use the Appendix instead of nginx."; exit 1 ;; esac
export DEBIAN_FRONTEND=noninteractive
command -v nginx >/dev/null || { apt-get update; apt-get install -y --no-install-recommends nginx </dev/null; }
if [ -d /etc/nginx/sites-available ]; then SITE=/etc/nginx/sites-available/scrappia; else SITE=/etc/nginx/conf.d/scrappia.conf; fi
if [ -n "$DOMAIN" ]; then LPORT=80; NAME="    server_name $DOMAIN;"; else LPORT=$PUBLIC_PORT; NAME="    # no-domain mode: reached at http://SERVER-IP:$PUBLIC_PORT"; fi
LISTEN="    listen $LPORT;"
[ -e /proc/net/if_inet6 ] && LISTEN="$LISTEN
    listen [::]:$LPORT;"
cat > "$SITE" <<NGINX
# Scrappia: REST API on 127.0.0.1:$PORT, MCP on 127.0.0.1:$MCP_PORT (written by DEPLOY.md, step 11)
server {
$LISTEN
$NAME
    access_log /var/log/nginx/scrappia.access.log;
    error_log  /var/log/nginx/scrappia.error.log;
    client_max_body_size 25m;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_set_header Connection "";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;

    location = /mcp {
        proxy_pass http://127.0.0.1:$MCP_PORT;
    }
    location / {
        proxy_pass http://127.0.0.1:$PORT;
    }
}
NGINX
[ "$SITE" = /etc/nginx/sites-available/scrappia ] && ln -sfn "$SITE" /etc/nginx/sites-enabled/scrappia
if ! nginx -t; then
  rm -f "$SITE" /etc/nginx/sites-enabled/scrappia
  echo "STOP: nginx config test failed. The scrappia site was removed and nothing was reloaded."; exit 1
fi
if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl enable --now nginx; fi
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  if [ -n "$DOMAIN" ]; then ufw allow 80/tcp; ufw allow 443/tcp; else ufw allow "$PUBLIC_PORT/tcp"; fi
fi
echo "OK: nginx site $SITE is live"
EOF
```

If your cloud provider has its own firewall (security groups), open TCP 80 and 443 there too, or TCP 8111 in no-domain mode.

### 11b. HTTPS certificate (domain mode only)

```bash
sudo bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1   # additive only: needrestart must not restart other services
source /etc/scrappia/deploy.conf
[ -n "$DOMAIN" ] || { echo "No DOMAIN set: no-domain mode, skip this step."; exit 0; }
[ -n "$EMAIL" ] || { echo "STOP: set EMAIL in /etc/scrappia/deploy.conf"; exit 1; }
SERVER_IP=$(curl -4fsS --max-time 10 https://api.ipify.org)
DNS_IPS=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')
case " $DNS_IPS" in
  *" $SERVER_IP "*) echo "OK: $DOMAIN points at $SERVER_IP" ;;
  *) echo "STOP: $DOMAIN resolves to '${DNS_IPS:-nothing}', not this server ($SERVER_IP). Fix the DNS A record (Cloudflare: DNS only) and retry."; exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive
if ! command -v certbot >/dev/null || ! dpkg -s python3-certbot-nginx >/dev/null 2>&1; then
  apt-get update; apt-get install -y --no-install-recommends certbot python3-certbot-nginx </dev/null
fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring
nginx -t && systemctl reload nginx
echo "OK: https://$DOMAIN is live"
EOF
```

Certbot edits only the `scrappia` server block, and the certbot package's timer renews the certificate automatically.

## 12. Verify

**Services and health:**

```bash
source /etc/scrappia/deploy.conf
systemctl is-active scrappia scrappia-mcp
curl -fsS "http://127.0.0.1:$PORT/health"; echo
curl -fsS "http://127.0.0.1:$MCP_PORT/health"; echo
if [ -n "$DOMAIN" ]; then curl -fsS "https://$DOMAIN/health"; echo; echo "Public URL: https://$DOMAIN"
else curl -fsS "http://127.0.0.1:$PUBLIC_PORT/health"; echo; echo "Public URL: http://$(curl -4fsS https://api.ipify.org):$PUBLIC_PORT"; fi
```

Expected:

- `active` twice;
- `{"ok":true,"version":"0.1.0",…}` from the API;
- `{"ok":true,"activeRuns":0}` from MCP;
- the same API answer again through nginx.

Open `https://DOMAIN/docs` in a browser to see the API reference.

**Create your first API key.** It's printed once, so store it in your password manager. `admin` covers everything. Create narrower `read` or `read,write` keys for integrations.

```bash
sudo /opt/scrappia/bin/scrappia api-key create admin --scopes admin
```

Use it (replace `sk_...`):

```bash
source /etc/scrappia/deploy.conf
KEY=sk_paste_your_key_here
if [ -n "$DOMAIN" ]; then BASE="https://$DOMAIN"; else BASE="http://127.0.0.1:$PUBLIC_PORT"; fi
curl -fsS -H "Authorization: Bearer $KEY" "$BASE/api/recipes"; echo
```

You should see `{"recipes":[]}`. Without the header the API answers `401`.

**Test the headless browser engine end to end.** This is a one-page trial of a bundled browser-mode example, and no files are written:

```bash
sudo /opt/scrappia/bin/scrappia run example:quotes-infinite-scroll --max-requests 1 --dry-run
```

It ends with a summary showing `status succeeded` and `rows` above 0. Runs started from the CLI execute in that command's own process, not in the service.

Other server CLI commands: `sudo /opt/scrappia/bin/scrappia --help`, for example `api-key list`, `api-key rm <id>`, `secrets set`, `ai add` and `runs`.

## 13. Connect AI agents (MCP)

Print your MCP URL and token:

```bash
sudo bash <<'EOF'
source /etc/scrappia/deploy.conf
if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN/mcp"; else URL="http://$(curl -4fsS https://api.ipify.org):$PUBLIC_PORT/mcp"; fi
echo "MCP URL:   $URL"
echo "MCP token: $(grep '^SCRAPPIA_MCP_TOKEN=' "$APP_HOME/shared/.env" | cut -d= -f2-)"
EOF
```

**Claude Code** (on your computer):

```bash
claude mcp add --transport http scrappia https://scrape.example.com/mcp --header "Authorization: Bearer YOUR_MCP_TOKEN"
```

**Any client that supports remote MCP over HTTP with headers** (format from `packages/mcp/README.md`):

```json
{ "mcpServers": { "scrappia": { "type": "http", "url": "https://scrape.example.com/mcp", "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" } } } }
```

Check it from anywhere. The answer should contain `"serverInfo":{"name":"scrappia"`:

```bash
curl -sS -X POST https://scrape.example.com/mcp \
  -H "Authorization: Bearer YOUR_MCP_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

**Stdio over SSH (alternative).** Clients that only launch local commands can start the stdio server on the VPS through SSH. This needs SSH key login as root, or as a user allowed to `sudo` without a password:

```bash
claude mcp add scrappia -- ssh -T root@YOUR_SERVER_IP /opt/scrappia/bin/scrappia-mcp
```

Each SSH session starts its own MCP process on the server, which shares the same data.

**Rotate the MCP token:** edit `SCRAPPIA_MCP_TOKEN` in `/opt/scrappia/shared/.env` (e.g. `openssl rand -hex 32`), run `sudo systemctl restart scrappia-mcp`, then update your clients.

> **Known limitation: two processes share one SQLite file.** The API service and the MCP service each open `scrappia.db`. The CLI helper does the same while it runs. The code opens SQLite without a busy timeout, so if two of these processes **write at the same instant**, one write fails with `database is locked`. Reads are never affected. It shows up in practice only when an agent-started run and a scheduled or API run are scraping at the same time. If it happens, the affected run is marked failed; resume it with `POST /api/runs/<id>/retry`. If you don't use agents, disable the MCP service (`sudo systemctl disable --now scrappia-mcp`) and the problem can't occur.

## Memory and concurrency

- **What uses memory.** In `browser` and `auto` mode, each parallel slot of a run launches its own Chromium. A recipe's `engine.concurrency` defaults to **4**, so one browser-mode run can use about 1–1.5 GB. Different recipes' schedules can overlap; the scheduler only skips a recipe whose previous run is still going. HTTP-mode runs are cheap.
- **Rule of thumb.** Allow about 300 MB for the server, plus 300 MB × the browser slots that can run at once. Set `MEMORY_MAX` (API service) and `MCP_MEMORY_MAX` (agent runs) in `deploy.conf` to what you can spare on this box. Re-run step 9 to apply.
- **What the cap does.** If a service reaches its cap, the kernel kills processes **inside that service only**, usually a Chromium. That page or run fails, and your other apps are unaffected. If runs fail with `Target page, context or browser has been closed` and the journal shows `oom-kill`, lower `engine.concurrency` in the recipes (2 on a 4 GB server is a good start), stagger schedules, or raise the cap.
- **Optional CPU cap**, e.g. 1.5 cores: `sudo systemctl set-property scrappia CPUQuota=150%`.
- Recipes must stay `headless: true`, which is the default. The server has no display, so `headless: false` fails there.

---

## Updating

```bash
sudo /opt/scrappia/bin/deploy.sh
```

This builds the latest `main` next to the running version, makes sure the matching Chromium is installed and starts, switches, restarts and health-checks. Any failure before the switch leaves the running version untouched; a failed health check rolls back automatically. If scrapes are running it stops and tells you; `sudo /opt/scrappia/bin/deploy.sh --force` cancels them. Recipes, runs and keys live in `shared/data` and are kept.

### Changing settings later

| You changed | Then run |
| --- | --- |
| Anything in `/opt/scrappia/shared/.env` | `sudo systemctl restart scrappia scrappia-mcp` |
| `MEMORY_MAX`, `MCP_MEMORY_MAX` | Step 9 |
| `PORT`, `MCP_PORT` | Steps 9 and 11, then `sudo /opt/scrappia/bin/deploy.sh` (its health check reads the new ports) |
| `DOMAIN` (incl. going from no-domain to a domain), `EMAIL`, `PUBLIC_PORT` | Steps 11 and 11b, then update your MCP clients' URL |
| `BRANCH` or `REPO_URL` | `sudo /opt/scrappia/bin/deploy.sh` |
| `NODE_MAJOR` | `sudo rm -rf /opt/scrappia/runtime/node`, step 5, then `sudo /opt/scrappia/bin/deploy.sh` |

## Rolling back

`deploy.sh` rolls back on its own when the health check fails. To go back by hand to the previous release:

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/scrappia/deploy.conf
CUR=$(readlink -f "$APP_HOME/current")
PREV=$(ls -1dt "$APP_HOME"/releases/*/ | sed 's:/$::' | grep -vx "$CUR" | head -n 1 || true)
[ -n "$PREV" ] || { echo "No previous release to roll back to"; exit 1; }
ln -sfn "$PREV" "$APP_HOME/current.new" && mv -Tf "$APP_HOME/current.new" "$APP_HOME/current"
for s in scrappia scrappia-mcp; do systemctl is-enabled --quiet "$s" && systemctl restart "$s"; done
echo "Now running $PREV"
EOF
```

The previous release's Chromium is still in `/opt/scrappia/browsers`. Patchright only removes browser builds once no kept release uses them.

## Logs, status, restart

```bash
sudo systemctl status scrappia scrappia-mcp --no-pager        # state, memory use vs. MemoryMax
sudo journalctl -u scrappia -f                                # API, scheduler and run logs (Ctrl+C to stop)
sudo journalctl -u scrappia-mcp -f                            # MCP server and agent-run logs
sudo journalctl -u scrappia -u scrappia-mcp --since "1 hour ago" --no-pager
sudo journalctl -k --since today | grep -i oom                # memory-cap kills
sudo systemctl restart scrappia scrappia-mcp                  # restart (cancels running scrapes)
sudo tail -f /var/log/nginx/scrappia.access.log /var/log/nginx/scrappia.error.log
```

For more detail, set `SCRAPPIA_LOG_LEVEL=debug` in `.env` and restart.

## Backups and restore

Everything lives in `/opt/scrappia/shared/`: the database `data/scrappia.db` (recipes, runs, rows, schedules, API key hashes, secrets, AI settings), exported files, browser profiles (saved logins), and `.env` (the MCP token and any API keys you put there).

A consistent backup while the service runs: the database is snapshotted with SQLite's `VACUUM INTO` (using the app's own Node), and the rest is archived.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/scrappia/deploy.conf
TS=$(date +%Y%m%d-%H%M%S); DIR="$APP_HOME/backups/$TS"
sudo -u "$APP_USER" mkdir -p "$DIR"
sudo -u "$APP_USER" "$APP_HOME/runtime/node/bin/node" --disable-warning=ExperimentalWarning -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("VACUUM INTO \x27" + process.argv[2] + "\x27"); db.close();' "$APP_HOME/shared/data/scrappia.db" "$DIR/scrappia.db"
tar -C "$APP_HOME/shared" --exclude='data/scrappia.db' --exclude='data/scrappia.db-wal' --exclude='data/scrappia.db-shm' -czf "$DIR/shared.tar.gz" data .env
tar -C "$APP_HOME/backups" -czf "$APP_HOME/backups/scrappia-$TS.tar.gz" "$TS"
rm -rf "$DIR"; chmod 600 "$APP_HOME/backups/scrappia-$TS.tar.gz"
ls -lh "$APP_HOME/backups/scrappia-$TS.tar.gz"
EOF
```

Copy it off the server, from your computer. As a non-root sudo user, first `sudo cp` the archive to your home directory and `sudo chown` it.

```bash
scp root@YOUR_SERVER_IP:'/opt/scrappia/backups/scrappia-*.tar.gz' .
```

**Restore.** By default this uses the newest archive; set `BACKUP=` to a specific file if you want an older one. It replaces the current data.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/scrappia/deploy.conf
BACKUP=$(ls -1t "$APP_HOME"/backups/scrappia-*.tar.gz | head -n 1)
echo "Restoring $BACKUP"
TMP=$(mktemp -d); tar -xzf "$BACKUP" -C "$TMP"
systemctl stop scrappia scrappia-mcp
rm -rf "$APP_HOME/shared/data"
tar -xzf "$TMP"/*/shared.tar.gz -C "$APP_HOME/shared"
install -m 600 -o "$APP_USER" -g "$APP_USER" "$TMP"/*/scrappia.db "$APP_HOME/shared/data/scrappia.db"
chown -R "$APP_USER:$APP_USER" "$APP_HOME/shared"; chmod 700 "$APP_HOME/shared/data"; chmod 600 "$APP_HOME/shared/.env"
rm -rf "$TMP"
for s in scrappia scrappia-mcp; do systemctl is-enabled --quiet "$s" && systemctl start "$s"; done
echo "Restored. Check: curl -fsS http://127.0.0.1:$PORT/health"
EOF
```

To move to a **new** server:

1. Follow steps 1–6, then step 9.
2. Copy the archive to `/opt/scrappia/backups/` and run the restore block. The services won't start yet, which is expected.
3. Continue with step 10.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Preflight: `port 3111 is used by …` | Another app already uses the port | Set `PORT` (or `MCP_PORT`) to a free port in `deploy.conf`; run steps 9 and 11, then deploy. |
| `deploy.sh`: `Permission denied (publickey)` | Deploy key not added, or added to another repo | Redo step 6, and add the key under *this* repo's **Settings → Deploy keys**. |
| `deploy.sh`: `!! N scrape(s) are running` | Safety stop | Wait, or use `--force`; resume cancelled runs with `POST /api/runs/<id>/retry`. |
| `Chromium failed to start: … error while loading shared libraries: libXXX.so` | A system library is missing | Re-run step 3. If it still fails, install the package that provides that file: `apt-file search libXXX.so`, or as a last resort `sudo env PATH=/opt/scrappia/runtime/node/bin:$PATH node /opt/scrappia/current/node_modules/patchright/cli.js install-deps chromium`. |
| `Executable doesn't exist at /opt/scrappia/browsers/...` in a run | Browser download interrupted, or the folder was removed | `sudo /opt/scrappia/bin/deploy.sh --force`; it reinstalls the matching Chromium. |
| Runs fail with `browser has been closed`, `oom-kill` in `journalctl -k` | Hit `MEMORY_MAX` | Lower `engine.concurrency`, stagger schedules, or raise `MEMORY_MAX` and re-run step 9. See [Memory and concurrency](#memory-and-concurrency). |
| `401 No API key configured; only loopback requests are accepted` | No API key created yet | Step 12: `sudo /opt/scrappia/bin/scrappia api-key create admin --scopes admin`. |
| `401 Bootstrap key is disabled because API keys exist` | `SCRAPPIA_API_KEY` used after real keys exist | Use a real key. The bootstrap key switches off by design once any key exists. |
| MCP client: `401 unauthorized` | Wrong or missing `Authorization: Bearer` | Print the token (step 13) and send it exactly. |
| MCP client hangs, or the run monitor's live view doesn't update | A proxy is buffering the event stream | With this nginx config it's handled (`proxy_buffering off`). Behind Cloudflare's proxy or another proxy, disable buffering there. |
| `database is locked` in a run | Simultaneous writes from the API and MCP processes | See the known limitation in step 13; retry the run. |
| `502 Bad Gateway` from nginx | Service not running or wrong port | `sudo systemctl status scrappia scrappia-mcp`, `sudo journalctl -u scrappia -n 50`; check the ports in `deploy.conf` match (re-run step 9). |
| `nginx -t` fails | Usually another site's error, or a duplicate `default_server` | The block already removed the scrappia site. Fix the file named in the first error line, then re-run step 11. |
| Certbot: `DNS problem` / `unauthorized` / timeout | A record wrong, Cloudflare proxy on, or port 80 closed | Check `getent ahostsv4 $DOMAIN`; set Cloudflare to DNS only; open 80 in ufw and the cloud firewall; re-run 11b. |
| Build killed / `JavaScript heap out of memory` | Not enough RAM for TypeScript | Step 3b (swap), then deploy again. |
| `EACCES` under `/opt/scrappia` | Files created as root by hand | `sudo chown -R scrappia:scrappia /opt/scrappia/shared /opt/scrappia/releases /opt/scrappia/repo /opt/scrappia/browsers /opt/scrappia/home` |
| A recipe with a login works on the desktop but not on the server | The recorder's cookies stay on your computer | Record the login as actions with secrets (see INSTALL.md, "Send recipes to the server"), and set the secrets on the server with `PUT /api/secrets/<name>`. |
| `ExperimentalWarning: SQLite is an experimental feature` | Node 22 labels `node:sqlite` experimental | Harmless. The units already hide it via `NODE_OPTIONS`. |

## Uninstall

This removes only what this guide created: both services, the nginx site and its logs, the certificate, the swap file, `/opt/scrappia` (code, data, Chromium, backups), `/etc/scrappia` and the user. It removes **no packages** and doesn't touch other sites. **Make a backup first** if you might want the data.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/scrappia/deploy.conf
systemctl disable --now scrappia.service scrappia-mcp.service 2>/dev/null || true
rm -f /etc/systemd/system/scrappia.service /etc/systemd/system/scrappia-mcp.service
rm -rf /etc/systemd/system.control/scrappia.service.d
systemctl daemon-reload
rm -f /etc/nginx/sites-enabled/scrappia /etc/nginx/sites-available/scrappia /etc/nginx/conf.d/scrappia.conf
rm -f /var/log/nginx/scrappia.access.log* /var/log/nginx/scrappia.error.log*
if command -v nginx >/dev/null && systemctl is-active --quiet nginx; then nginx -t && systemctl reload nginx; fi
if [ -n "$DOMAIN" ] && command -v certbot >/dev/null; then certbot delete --cert-name "$DOMAIN" --non-interactive || true; fi
if [ -z "$DOMAIN" ] && command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw delete allow "$PUBLIC_PORT/tcp" || true; fi
if [ -f /swapfile-scrappia ]; then
  swapoff /swapfile-scrappia 2>/dev/null || true
  rm -f /swapfile-scrappia
  sed -i '\#^/swapfile-scrappia #d' /etc/fstab
fi
rm -rf /opt/scrappia /etc/scrappia
id -u scrappia >/dev/null 2>&1 && userdel scrappia || true
getent group scrappia >/dev/null && groupdel scrappia || true
echo "Scrappia removed."
EOF
```

Finally, delete the deploy key on GitHub (**Settings → Deploy keys** of `cyberkyd01/Scrappia`) and remove the MCP server from your AI clients.

## Appendix: Caddy / Apache instead of nginx

Use this when ports 80/443 already belong to Caddy or Apache. Do steps 1–10 as written, skip 11 and 11b, then add one of the following. They use the default ports `3111` (API) and `3211` (MCP); use your values from `deploy.conf`. Both servers send `X-Forwarded-For` by default. Keep it.

**Caddy.** Add a site block to your Caddyfile (usually `/etc/caddy/Caddyfile`), then run `sudo systemctl reload caddy`. Caddy gets the certificate itself.

```caddy
scrape.example.com {
    handle /mcp {
        reverse_proxy 127.0.0.1:3211 {
            flush_interval -1
        }
    }
    handle {
        reverse_proxy 127.0.0.1:3111 {
            flush_interval -1
        }
    }
}
```

**Apache** (Debian/Ubuntu layout). Create `/etc/apache2/sites-available/scrappia.conf`:

```apache
<VirtualHost *:80>
    ServerName scrape.example.com
    ProxyPreserveHost On
    ProxyTimeout 3600
    RequestHeader set X-Forwarded-Proto "expr=%{REQUEST_SCHEME}"
    ProxyPass        /mcp http://127.0.0.1:3211/mcp flushpackets=on
    ProxyPassReverse /mcp http://127.0.0.1:3211/mcp
    ProxyPass        /    http://127.0.0.1:3111/ flushpackets=on
    ProxyPassReverse /    http://127.0.0.1:3111/
    ErrorLog  ${APACHE_LOG_DIR}/scrappia.error.log
    CustomLog ${APACHE_LOG_DIR}/scrappia.access.log combined
</VirtualHost>
```

Then enable it and get the certificate. `a2enmod` makes no change if a module is already enabled.

```bash
sudo a2enmod proxy proxy_http headers
sudo a2ensite scrappia
sudo apache2ctl configtest && sudo systemctl reload apache2
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get install -y --no-install-recommends certbot python3-certbot-apache
sudo certbot --apache -d scrape.example.com --non-interactive --agree-tos -m you@example.com --redirect
```
