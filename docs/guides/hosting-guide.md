# Hosting guide: run Scrappia on a server

> For a Linux VPS, the canonical step-by-step guide is **[DEPLOY.md](../../DEPLOY.md)**: isolated Node and Chromium, systemd services for the API and the MCP server, nginx, HTTPS, backups, and updates with automatic rollback. The options below remain as quick alternatives.

Use this when scrapers must run on a schedule without your computer being on, when several people
need access, or when other software needs to pull data through the API.

The server piece is called `@scrappia/server`. It exposes a REST API, runs the scheduler, and uses
exactly the same engine as the desktop app. It stores everything in one folder (SQLite database,
exports, browser profiles), so backing it up means copying one folder.

## Choosing a setup

| You have... | Use |
|---|---|
| A Windows or Mac computer that stays on | **Option A**: run the server directly, optionally as a service |
| A Linux VPS (DigitalOcean, Hetzner, AWS, ...) | **Option B**: Docker (simplest) or **Option C**: Node + systemd |
| No server yet | Any provider's smallest Linux VM with 2 GB RAM is enough; browser mode is happier with 4 GB |

Whatever you choose, the steps are the same in spirit: install, set an API key, start, then put
HTTPS in front if it is reachable from the internet.

## Option A: run directly on a computer you own

1. Follow steps 1 to 3 of [Getting started](getting-started.md) (Node, download, install, build).
2. Pick a strong API key. It is the password other programs use. For example generate one at
   https://www.random.org/strings/ or run `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
3. Start the server. Windows (cmd):

   ```
   cd C:\path\to\Scrappia
   set SCRAPPIA_API_KEY=paste-your-key-here
   node apps\server\dist\index.js
   ```

   macOS / Linux:

   ```
   cd /path/to/Scrappia
   SCRAPPIA_API_KEY=paste-your-key-here node apps/server/dist/index.js
   ```

4. Open http://localhost:8788/docs in a browser. You should see the API documentation page. The
   health check is http://localhost:8788/health.

To keep it running after you close the terminal:

- **Windows**: create a scheduled task that runs at startup. Open Task Scheduler → Create Task →
  Triggers: At startup → Actions: Start a program: `node`, arguments
  `apps\server\dist\index.js`, start in: your Scrappia folder → under "Conditions" untick "Start
  only if on AC power". Put `SCRAPPIA_API_KEY` in the system environment variables (Control Panel →
  System → Advanced → Environment Variables).
- **macOS**: use `launchd` or the free app "LaunchControl", or simply the systemd-style tool `pm2`:
  `npm i -g pm2 && pm2 start apps/server/dist/index.js --name scrappia && pm2 save && pm2 startup`.
- **Linux**: see Option C.

## Option B: Docker (recommended for Linux servers)

Docker packages Scrappia with the browser and all dependencies so nothing else needs installing.

1. Install Docker: https://docs.docker.com/engine/install/ (choose your Linux flavour) and run
   `sudo usermod -aG docker $USER`, then log out and in.
2. Get the code on the server:

   ```
   git clone https://github.com/cyberkyd01/Scrappia.git
   cd Scrappia
   ```

3. Create a file named `.env` next to `docker-compose.yml` with your key:

   ```
   SCRAPPIA_API_KEY=paste-your-key-here
   ```

   Optional lines: `ANTHROPIC_API_KEY=...` or `OPENAI_API_KEY=...` to enable AI features,
   `SCRAPPIA_LOG_LEVEL=debug` for more logs.

4. Build and start (the first build takes a few minutes; it downloads Chromium):

   ```
   docker compose up -d --build
   ```

5. Check it: `curl http://localhost:8788/health` should print `{"ok":true,...}`.

Useful commands:

```
docker compose logs -f          # watch the logs
docker compose restart          # restart
docker compose down             # stop (data is kept in the volume)
docker compose up -d --build    # update after git pull
```

Your data lives in a Docker volume named `scrappia-data`, mounted at `/data` inside the container.
To back it up: `docker run --rm -v scrappia-data:/data -v $PWD:/backup alpine tar czf /backup/scrappia-backup.tgz /data`.

## Option C: Linux with Node and systemd

1. Install Node 22: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git`.
2. Get and build the code:

   ```
   sudo mkdir -p /opt/scrappia && sudo chown $USER /opt/scrappia
   git clone https://github.com/cyberkyd01/Scrappia.git /opt/scrappia
   cd /opt/scrappia
   npm install
   npx patchright install --with-deps chromium
   npm run build
   ```

3. Create a service file `/etc/systemd/system/scrappia.service`:

   ```
   [Unit]
   Description=Scrappia server
   After=network.target

   [Service]
   WorkingDirectory=/opt/scrappia
   Environment=SCRAPPIA_API_KEY=paste-your-key-here
   Environment=SCRAPPIA_HOME=/var/lib/scrappia
   Environment=PORT=8788
   Environment=NODE_ENV=production
   ExecStart=/usr/bin/node apps/server/dist/index.js
   Restart=always
   RestartSec=5
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```

4. Create the data folder and start:

   ```
   sudo mkdir -p /var/lib/scrappia && sudo chown www-data /var/lib/scrappia
   sudo systemctl daemon-reload
   sudo systemctl enable --now scrappia
   sudo systemctl status scrappia
   ```

Logs: `journalctl -u scrappia -f`.

## Making it reachable from the internet, safely (HTTPS)

Never expose port 8788 directly. Put a reverse proxy with a free certificate in front. The easiest
is Caddy.

1. Point a domain (for example `scrappia.example.com`) at your server's IP address in your DNS
   provider.
2. Install Caddy: https://caddyserver.com/docs/install.
3. Put this in `/etc/caddy/Caddyfile`:

   ```
   scrappia.example.com {
       reverse_proxy 127.0.0.1:8788
   }
   ```

4. `sudo systemctl reload caddy`. Caddy obtains and renews the certificate automatically.

Now use `https://scrappia.example.com/docs` instead of `http://localhost:8788/docs`. If your
firewall is on, allow ports 80 and 443 only. Nginx works too; proxy to 127.0.0.1:8788 and enable
`proxy_buffering off` for the live event stream.

## Settings reference (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `SCRAPPIA_API_KEY` | none | Bootstrap key. Accepted until you create a real key through the API; after that it stops working (by design). |
| `PORT` | 8788 | Port to listen on |
| `HOST` | 0.0.0.0 | Address to bind; use 127.0.0.1 when a reverse proxy is on the same machine |
| `SCRAPPIA_HOME` | ~/.scrappia | Data folder |
| `SCRAPPIA_CORS` | none | Allowed browser origins for the API, e.g. `https://app.example.com` |
| `SCRAPPIA_RATE_LIMIT` | 600 | Requests per minute per API key |
| `SCRAPPIA_LOG_LEVEL` | info | `debug`, `info`, `warn`, `error` |
| `SCRAPPIA_LOG_JSON` | off | `1` for one JSON object per log line (for log collectors) |
| `SCRAPPIA_NO_SCHEDULER` | off | `1` to run the API without the scheduler (for extra API replicas) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_HOST` | none | Auto-detected AI providers when none are configured in settings |

## After the first start: create a real API key

The bootstrap key from the environment is meant for the first minutes only. Create a proper key,
store it somewhere safe, and remove the environment variable afterwards:

```
curl -X POST https://scrappia.example.com/api/api-keys \
  -H "Authorization: Bearer paste-your-bootstrap-key" \
  -H "Content-Type: application/json" \
  -d '{"name":"my laptop","scopes":"read,write"}'
```

The response contains the new key once. See the [Admin guide](admin-guide.md) for scopes.

## Sizing and performance

- HTTP-mode scraping is cheap: a 1 vCPU / 2 GB server handles thousands of pages per minute.
- Browser mode needs about 300 MB RAM per parallel page. Set `engine.concurrency` in recipes
  accordingly (2 to 4 on a 4 GB server).
- Exports and the database are on disk; keep 10 GB free.
- The scheduler skips a run if the previous run of the same recipe is still going, so overlapping
  schedules never pile up.

## Updating

```
cd /opt/scrappia            # or your folder
git pull
npm install
npm run build
sudo systemctl restart scrappia      # or: docker compose up -d --build
```

Recipes and runs are kept; the database migrates itself on start.
