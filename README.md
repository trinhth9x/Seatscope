# Seatscope

**See every seat. Reclaim the wasted ones.**

Seatscope is an open-source dashboard that shows SaaS license **usage, cost, waste, inactive users, and upcoming renewals** across all connected services — so companies can reclaim seats and save money. Read-only: it never changes your accounts.

> Value story: charge ~$20/mo, save the customer hundreds by reclaiming unused GitHub / Microsoft 365 / Azure DevOps / etc. seats.

## Requirements

- **Node.js 20+** (Node 24 recommended) — only needed for the non-Docker installs, or
- **Docker** (recommended — no Node needed on the host; the image ships Node 24).

Seatscope starts on **mock data** so you can explore the whole UI before adding any
real credentials. Connectors are configured later in the web UI (Connectors page).

## 🚀 Deploy

### 🐳 Docker (recommended)

Using Docker Compose (persists your config in a named volume):

```bash
git clone https://github.com/trinhth9x/Seatscope.git
cd Seatscope
docker compose up -d
```

Or with plain Docker:

```bash
docker build -t seatscope .
docker run -d --name seatscope -p 4000:4000 -v seatscope-data:/app/data seatscope
```

Open **http://localhost:4000**. To update: `git pull && docker compose up -d --build`.

### 🐧 Linux

```bash
# Node.js 20+ required, Node 24 recommended (e.g. via nodesource or your distro's package manager)
git clone https://github.com/trinhth9x/Seatscope.git
cd Seatscope
npm ci --omit=dev
npm start          # runs on http://localhost:4000
```

**Run in the background with PM2** (auto-restart + start on boot):

```bash
npm install -g pm2
pm2 start server.js --name seatscope
pm2 save && pm2 startup      # follow the printed command to enable on boot
```

Or as a **systemd service** — create `/etc/systemd/system/seatscope.service`:

```ini
[Unit]
Description=Seatscope
After=network.target

[Service]
WorkingDirectory=/opt/Seatscope
ExecStart=/usr/bin/node server.js
Environment=PORT=4000
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now seatscope
```

### 🪟 Windows

```powershell
# Install Node.js 20+ (Node 24 recommended) from https://nodejs.org first
git clone https://github.com/trinhth9x/Seatscope.git
cd Seatscope
npm ci --omit=dev
npm start          # runs on http://localhost:4000
```

To keep it running in the background / start with Windows, use PM2:

```powershell
npm install -g pm2 pm2-windows-startup
pm2 start server.js --name seatscope
pm2 save
pm2-startup install
```

## Configuration

No configuration is required to start — Seatscope boots on mock data. To connect
real services, open the **Connectors** page in the web UI and add credentials there
(they are stored on your server under `data/`, never committed).

Optional environment variables:

- `PORT` — HTTP port (default `4000`).
- `DATA_SOURCE` — `mock` (default) or `live`. You can also toggle this from the UI.
- `REFRESH_INTERVAL_HOURS` — how often the server re-runs the connectors for fresh
  data (default `168`, i.e. weekly). Set to `0` to disable auto-refresh. The **↻ Refresh**
  button in the UI always fetches live data on demand regardless of this setting.

## Architecture

```diagram
╭───────────────╮   collect()   ╭──────────────╮   buildDashboard()  ╭───────────╮
│  Connectors   │ ────────────▶ │  Raw model   │ ──────────────────▶ │ Dashboard │
│ mock / live   │               │ services,    │                     │ KPIs +    │
│ (per vendor)  │               │ skus, people,│                     │ tables +  │
│               │               │ assignments  │                     │ charts    │
╰───────────────╯               ╰──────────────╯                     ╰─────┬─────╯
                                                                           │ /api/dashboard
                                                                     ╭─────▼─────╮
                                                                     │  Portal   │
                                                                     │  (web UI) │
                                                                     ╰───────────╯
```

- **Connectors** (`src/connectors/*.js`) each implement `async collect()` returning the same raw shape. Add a new vendor without touching the rest.
- **`src/aggregate.js`** holds the central "waste" logic (`STALE_DAYS = 45`; `never` = assigned but never used, `idle` = no activity 45+ days).
- **`server.js`** loads the connector chosen by `DATA_SOURCE`, caches the result, and serves `/api/dashboard`.
- **`public/`** is the professional dashboard (Overview, Wasted licenses, Inactive users, Renewals).

## Live connectors (implemented)

Set `DATA_SOURCE=live`. Every connector with credentials in `.env` runs and is merged.
Add a vendor = one file + one line in `src/connectors/live.js`.

### GitHub Copilot — `src/connectors/github.js` (fastest proof)
The Copilot billing API returns **exact `last_activity_at` per seat**, so unused paid
seats are measured, not guessed.
- `GITHUB_ORG`, `GITHUB_TOKEN` (org owner; classic scopes `read:org`, `manage_billing:copilot`)
- Optional `GITHUB_COPILOT_UNIT_COST` to set your negotiated price/seat.

### Microsoft 365 / Entra — `src/connectors/m365.js`
App-only Microsoft Graph. Flags users holding E5/E3/Power BI/Copilot seats who
haven't signed in for weeks.
- `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`
- Entra app Application permissions (read-only, admin-consented):
  `Organization.Read.All`, `User.Read.All`, `AuditLog.Read.All`
- `signInActivity` (last-used) needs **Entra ID P1** on the tenant.
- Graph has no price API — edit `PRICE_MAP` in `m365.js` with your contract prices.

All connectors return `{ services, skus, people, assignments }`; the "waste" logic
lives once in `src/aggregate.js`.

## Security

Seatscope is **read-only** — it never modifies your accounts. Credentials stay on
your own server: `.env` and everything under `data/` (including `data/connectors.json`,
which holds connector tokens) are git-ignored and are **never** committed.

### Automated scanning (all free for public repos)

| Scan | What it does | Setup |
| --- | --- | --- |
| **SonarCloud** (Automatic Analysis) | Static analysis — code quality + security rules | Import the repo once on SonarCloud (see below) |
| [`security.yml`](.github/workflows/security.yml) | **CodeQL** SAST · **npm audit** (dependency vulns) · **Gitleaks** (secret scan) | None — uses the built-in `GITHUB_TOKEN` |

The `security.yml` jobs run on every push/PR to `main` and weekly.

**SonarCloud setup** (one-time, free for public repos):

1. Sign in to [SonarCloud](https://sonarcloud.io) with GitHub and **import the repository**.
2. Leave **Automatic Analysis** enabled (the default) — no token or workflow needed.
   File/scan tuning lives in [`.sonarcloud.properties`](.sonarcloud.properties).

## Support

Seatscope is free and open source. If it helps your team cut wasted license spend:

- ⭐ **Star the repo** — it's the biggest help for visibility.
- 🛠️ **Need commercial support or a custom connector?** [Open an issue](../../issues) to get in touch.

## License

[MIT](LICENSE) — free to use, self-host, modify and redistribute. No warranty.
