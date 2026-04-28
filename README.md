# hub

The workspace where four products evolve together as one stack: drafts, telepath, wizapp, buffer.

This is the upstream. drafts.labs.vc and the projects running on it pull from here. Production servers do not edit themselves — they consume what hub publishes.

---

## What lives here

| Path | What | Upstream of |
|---|---|---|
| `drafts/` | Drafts protocol + runtime + telepath bot. Single Node process. | `/opt/drafts` on every drafts server |
| `projects/wizapp/` | Wizapp — Akinator-style wizard that turns vague intent into a build-ready prompt | `/var/lib/drafts/wizapp/live/` |
| `projects/buffer/` | Buffer — 10-folder workspace cache for AI sessions (folder name = address = write key) | `/var/lib/drafts/buffer/live/` |
| `setup/` | Everything needed to bring a fresh Ubuntu box from zero to a fully running drafts server | new servers |

drafts and telepath share one repo because they share one Node process. wizapp and buffer are static drafts-projects (HTML + manifest), they live as files inside the drafts runtime.

---

## Bringing up a new server

Provision a fresh Ubuntu 24.04 box, get root, then:

```bash
git clone https://github.com/g0rd33v/hub.git
cd hub/setup
cp env.example .env
# edit .env: set SERVER_NUMBER, TG_BOT_TOKEN, CF_API_TOKEN, CF_ZONE_ID
sudo ./install.sh
```

`install.sh` does, in order:

1. Installs Node 20, pm2, nginx, certbot, cockpit, git
2. Clones the hub repo into `/opt/hub`
3. Copies `hub/drafts/` → `/opt/drafts/`, runs `npm ci`
4. Copies `hub/projects/wizapp/` and `hub/projects/buffer/` to `/var/lib/drafts/<project>/live/`
5. Calls Cloudflare API to create A record `drafts<N>.labs.vc` → server IP
6. Issues Let's Encrypt cert via certbot --nginx
7. Renders nginx.conf from template, restarts nginx
8. Installs cockpit, opens port 9090
9. Registers drafts process with pm2, saves pm2 startup
10. Prints SAP-pass URL — copy it, send `/start` to your master Telegram bot, paste it in.

Total time on a fresh DigitalOcean droplet: about 8-10 minutes.

---

## Working in hub

Hub is the place where these four products are improved together. Workflow:

1. Make changes in the relevant subdirectory of hub
2. Test locally or on a sandbox server
3. Commit and push to hub `main`
4. Production servers pull from hub on next auto-update cycle (or manually `cd /opt/drafts && git pull && pm2 restart drafts`)

Do not edit production directly. Hub is the source of truth.

---

## Why this exists

Before hub, each product had its own life. Drafts was in `drafts-protocol`, wizapp and buffer were just project folders sitting on a server, telepath was bundled inside drafts, the setup steps were scattered across notes and one-off scripts.

Hub exists so the four can be developed as a coordinated whole, smoke-tested as a kit, then propagated back out in lockstep. One repo, one PR, one commit can change all of them at once.

---

## License

MIT. See LICENSE.
