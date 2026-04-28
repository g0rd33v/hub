# Hub

Single workspace where the Labs server stack is developed end-to-end.

Drafts protocol, Telepath master bot, the wizapp and buffer projects, and the
new-server bootstrap all live here together. They are tested as one set,
released as one set, and propagated downstream from here.

This repo is the upstream. Production servers (`drafts.labs.vc`, future
`drafts2.labs.vc`, ...) pull from hub. Hub does not pull from them.

## Layout

```
hub/
├── drafts/            drafts protocol server + telepath master bot
│   ├── drafts.js          main HTTP server (projects, runtime, registry, AAP/PAP/SAP)
│   ├── telepath.js        Telegram master bot ("@drafts_bot" style)
│   ├── runtime.js         per-project runtime engine (bot.js + cron.json)
│   ├── analytics.js       webhook + bot analytics
│   ├── project-bots.js    per-project bot wiring
│   ├── rich-context.js    context builder
│   ├── app.js             entry point that wires all of the above
│   ├── package.json
│   └── ... (deploy/, docs/, scripts/, static/, README, CHANGELOG)
│
├── projects/          projects that ship with every new server
│   ├── wizapp/            Akinator-style wizard → build-ready prompt
│   └── buffer/            AI-session workspace cache
│
├── setup/             new-server bootstrap (max automation)
│   ├── install.sh         one-shot: Node + pm2 + nginx + Cloudflare DNS + Let's Encrypt + Cockpit
│   ├── auto-update.sh     cron job that pulls hub and redeploys drafts
│   ├── nginx.conf.template
│   └── .env.example
│
└── README.md          this file
```

## How a new server gets born

Server N (numeric) gets the domain `draftsN.labs.vc` automatically.
Prerequisites: a fresh Ubuntu 24.04 box with public IP and root SSH.

```bash
# on the new box, as root:
git clone https://github.com/g0rd33v/hub /opt/hub
cd /opt/hub/setup
cp .env.example .env
# edit .env: set SERVER_NUMBER, PUBLIC_BASE, TG_BOT_TOKEN, optionally CF_*
bash install.sh
```

In ~10 minutes you have:

- `https://draftsN.labs.vc` serving drafts (Let's Encrypt)
- `https://draftsN.labs.vc:9090` Cockpit admin UI
- pm2 + systemd ensuring drafts restarts on reboot
- cron (`/etc/cron.d/drafts-autoupdate`) pulling hub every 15 min and redeploying drafts on change
- a generated SAP token in `/etc/labs/drafts.sap` for the master bot
- the master Telegram bot polling for updates

Cloudflare DNS is automated when `CF_API_TOKEN` + `CF_ZONE_ID` are set.
Without them, `install.sh` prints the IP it expects and you set the A record by hand.

## Develop here, propagate downstream

The intended flow is:

1. Open this repo on your laptop or on any server that has it cloned.
2. Edit `drafts/`, `projects/`, or `setup/` as a coherent set.
3. Push to `main`.
4. Within 15 min every server running this hub picks up the change automatically
   (drafts/ changes trigger pm2 restart; projects/ changes do not — they are
   imported into a server's drafts state by the operator on demand).

## What lives here vs what doesn't

In hub:

- The drafts server source code (the runtime engine for the protocol)
- Telepath — the master bot that operates a single drafts server
- wizapp + buffer — projects considered part of the standard distribution
- Setup automation for new servers

Not in hub:

- Per-project runtime data (lives in `/var/lib/drafts/<project>/` on each server)
- Server-specific secrets (SAP tokens, bot tokens — generated/configured per server, never committed)
- User-created projects (those live on the servers and are managed via the master bot)

## Status

| Component   | Source of truth | Production       |
| ----------- | --------------- | ---------------- |
| drafts      | `hub/drafts/`   | drafts.labs.vc   |
| telepath    | `hub/drafts/telepath.js` | drafts.labs.vc |
| wizapp      | `hub/projects/wizapp/` | drafts.labs.vc |
| buffer      | `hub/projects/buffer/` | drafts.labs.vc |
| setup       | `hub/setup/`    | new servers      |

Server 1 = `drafts.labs.vc` (live, v1.0). Server 2 = `drafts2.labs.vc` (in provisioning).

## License

MIT. See `drafts/LICENSE` for the drafts protocol license; same applies to hub as a whole.
