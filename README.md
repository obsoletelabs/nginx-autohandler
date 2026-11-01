# nginx-autohandler

One container that runs nginx with a web editor for its config, DNS-01 certificates from Let's Encrypt, Cloudflare DNS, and notifications to Discord and email.

- **Files:** browse, view, edit, create and delete under `/etc/nginx`.
- **Raw and Blocks editors.** Blocks is the structured view from `nginx_model/`: directives, nested blocks and comments are editable as rows. It keeps comments and any directive it doesn't model. Formatting is normalised to four spaces, so an unedited file can change layout when it goes through Blocks.
- **Safe apply:** every save writes the file, runs `nginx -t` on the whole config, and reloads if auto-reload is on. If the test or reload fails, the previous file is restored and your text stays in the editor.
- **Backups:** each change snapshots the old file. The last 4 per file are kept. History restores any of them.
- **Cloudflare:** a `server_name` saved in a config gets an A record pointing at this host. Tracked records are kept on this host's public IP on a timer.
- **Certificates:** Let's Encrypt via DNS-01 on Cloudflare, so wildcards work. Staging is the default. Certificates renew every 12 hours, with a notification on failure.
- **Notifications:** Discord and email both fire when both are set. Failure on one doesn't stop the other.
- **Settings and secrets:** set them in the Settings dialog or in `.env`. An environment value always wins and locks the field in the UI. Secrets are write-only: the UI only shows whether they are set.

## Run it

```bash
cp .env.example .env          # optional: fill in anything you want locked from the environment
docker compose up -d --build
```

- Editor: **http://localhost:8090** (host port 8090 maps to the container's 8080, because 8080 is taken on this PC). Put your TLS reverse proxy in front for remote access.
- Login: `UI_USER` / `UI_PASSWORD` from `.env`. Leave `UI_PASSWORD` empty if a proxy handles login.
- nginx: ports 80 and 443.
- Config: `./data/nginx`. An empty directory is seeded with the image's default config on first start.
- App state, settings, backups, certbot state: `./data/ui`.
- Certificates: `./data/certs` (mounted at `/etc/letsencrypt`).

## Settings

| Setting | Environment variable | Notes |
| --- | --- | --- |
| Cloudflare API token | `CLOUDFLARE_API_TOKEN` | Secret. Needs Zone:Read and DNS:Edit on the zones you use. |
| Proxy new records | `CLOUDFLARE_PROXIED` | Orange cloud on new A records. Default off. |
| IP sync | `CLOUDFLARE_IP_SYNC` | Keep tracked records on the public IP. Default on. |
| DNS from configs | `CLOUDFLARE_DNS_FROM_CONFIGS` | A records for `server_name` on save. Default on. |
| IP sync interval | `CLOUDFLARE_CHECK_INTERVAL_SECONDS` | Default 600. |
| Extra DNS domains | `CLOUDFLARE_DOMAINS` | Comma separated. The DNS dialog keeps its own list too. |
| Let's Encrypt email | `ACME_EMAIL` | Required for certificates. |
| Staging | `ACME_STAGING` | Default on. Turn off only for real certificates. |
| SMTP host, port, security | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` | Security is `none`, `starttls` (default) or `ssl`. |
| SMTP login | `SMTP_USERNAME`, `SMTP_PASSWORD` | Password is secret. |
| SMTP addresses | `SMTP_FROM`, `SMTP_TO` | `SMTP_TO` is comma separated. |
| Discord webhook | `DISCORD_WEBHOOK_URL` | Secret. |
| Auto-reload | `NGINX_AUTO_RELOAD` | Default on. |
| Backups kept | `NGINX_AUTOHANDLER_BACKUP_KEEP` | Default 4. |
| Login | `UI_USER`, `UI_PASSWORD` | Environment only, so the UI can't lock you out. |

## Certificates

Certificates use DNS-01 through the Cloudflare token, so port 80 doesn't need to be reachable. Each domain needs to be in a zone the token can see. Wildcards must be issued this way. Issuing also creates A records for the names you entered, pointing at this host.

## Layout

| File | Purpose |
| --- | --- |
| `server.py` | HTTP server, file API, apply and rollback, DNS sync loop |
| `nginx_model/` | Vendored from `nginx_attempt2`: the lossless parser, renderer, editing and validation |
| `settings.py` | Settings and secrets, environment precedence, write-only secrets |
| `notify.py` | Discord and SMTP notifications |
| `certs.py` | certbot wrapper for DNS-01 issue and renewal |
| `cloudflare.py` | Cloudflare API client: zones, A records, retries, public IP |
| `static/` | Editor UI: plain HTML, CSS and JS, no build step |
| `entrypoint.sh` | Seeds the config, starts the app, runs nginx in the foreground |
| `tests/` | `python tests/test_autohandler.py`. The vendored suites run with `python -m unittest nginx_model.tests.test_toolkit nginx_model.tests.test_editing` |

## Notes

- The app runs as root, like nginx. Anyone who can reach the UI can change nginx config, so keep it behind login or a proxy.
- Cloudflare calls: `GET /zones` (paginated) finds the zone, then `GET /zones/{id}/dns_records` finds the record, then `POST` or `PATCH` writes it. 429 and 5xx responses are retried with backoff.
- `nginx_model/` also has import, export, include-graph and JSON storage features. The editor uses only parse and render so far.
