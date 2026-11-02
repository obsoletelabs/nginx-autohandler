# nginx-autohandler

One container that runs nginx with a web editor for its config, DNS-01 certificates from Let's Encrypt, Cloudflare DNS, and notifications to Discord and email.

- **Files:** browse, view, edit, create and delete under `/etc/nginx`.
- **Raw and Blocks editors.** Blocks is the structured view from `nginx_model/`: directives, nested blocks and comments are editable as rows. It keeps comments and any directive it doesn't model. Formatting is normalised to four spaces, so an unedited file can change layout when it goes through Blocks.
- **Safe apply:** every save writes the file, runs `nginx -t` on the whole config, and reloads if auto-reload is on. If the test or reload fails, the previous file is restored and your text stays in the editor.
- **Backups:** each change snapshots the old file. The last 4 per file are kept. History restores any of them.
- **Cloudflare:** a `server_name` saved in a config gets an A record pointing at this host. Tracked records are kept on this host's public IP on a timer.
- **Certificates:** ACME via DNS-01 on Cloudflare (Let's Encrypt, ZeroSSL, Google or a custom CA), self-signed, uploaded and bind-mounted certificates, expiry warnings, and automatic renewal.
- **Logs:** nginx, app and certbot logs are readable and searchable in the editor.
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

### A minimal compose file

This is all you need. The image is published to GitHub Container Registry as `ghcr.io/obsoletelabs/nginx-autohandler` (`latest` follows `main`, version tags such as `1.0.0` follow releases; amd64 and arm64). While the package is private, run `docker login ghcr.io` with a token that has `read:packages` first. To build from a checkout instead, replace the `image:` line with `build: .`. Everything else is optional and can be set later in the Settings dialog.

```yaml
services:
  nginx-autohandler:
    image: ghcr.io/obsoletelabs/nginx-autohandler:latest
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "8090:8080"             # the editor (put your TLS proxy in front of it)
    environment:
      UI_PASSWORD: ${UI_PASSWORD:-}          # empty = no login (use a proxy), or set one
      CLOUDFLARE_API_TOKEN: ${CLOUDFLARE_API_TOKEN:-}
      ACME_EMAIL: ${ACME_EMAIL:-}
      TZ: ${TZ:-UTC}                         # local time shown in emails
    volumes:
      - ./data/nginx:/etc/nginx              # your config (an empty folder is seeded)
      - ./data/ui:/var/lib/nginx-autohandler # settings, backups, state
      - ./data/certs:/etc/letsencrypt        # certificates
      - ./data/logs:/var/log/nginx           # nginx logs
      # - ./my-certs:/certs:ro               # certificates managed elsewhere, shown read-only
```

And a matching `.env` (never commit it):

```
UI_PASSWORD=change-me
CLOUDFLARE_API_TOKEN=your-token-with-Zone:Read-and-DNS:Edit
ACME_EMAIL=you@example.com
TZ=Europe/London
```

The full `docker-compose.yml` in this repository lists every setting, and `.env.example` documents each one.

### Only need one half?

This image combines two smaller projects. If you only want one of the jobs, use that project on its own:

- **Dynamic DNS for Cloudflare only:** [obsoletelabs/cloudflare_updater](https://github.com/obsoletelabs/cloudflare_updater)
- **Auto-reload nginx when its config changes, with Discord and email reports:** [obsoletelabs/nginx-reloading](https://github.com/obsoletelabs/nginx-reloading)

## What it replaces

This container folds in two of the obsoletelabs tools, with the new editor on top:

- **cloudflare_updater:** the public IP is read from whoami URLs (first answer wins). When it changes, every A record that pointed at the old IP is moved to the new one (records on other IPs are left alone, so a name can be shared by several hosts), the IP is saved in `persistent_ip.txt`, and Discord and email are told. A first start sends the welcome email, later starts send a restart notice. A flip between a private and a public address is refused and explained by email.
- **nginx-reloading:** edits made outside the page (SMB, openvscode, nano in the container) are noticed by polling. The whole config is tested first, nginx is reloaded only when the test passes, and the result is reported with a diff against the last known good copy. Edits made through the page are reported the same way.

The **Activity** feed in the UI lists recent config events. `GET /api/activity` returns the same list.

### whoami format

Each URL may answer in the Traefik `whoami` format or with a bare IP:

```
Name: my-whoami
RemoteAddr: 203.0.113.9:51234
X-Forwarded-For: 203.0.113.9
```

`X-Forwarded-For` wins over `RemoteAddr`. URLs are validated once, as in the updater: `ENFORCE_DNS_RESOLUTION`, `TEST_URL_CONNECTIVITY`, `ENFORCE_URL_CONNECTIVITY`, `ENFORCE_URL_VALIDITY`. If nothing usable is left, public lookup services are used.

## Settings

Every setting can be set from the Settings dialog or the environment. A non-empty environment value wins and locks the field. Secrets are write-only in the UI. The long list with defaults is in [`.env.example`](.env.example). The names used by the two original tools work too (for example `NOTIFIER_SMTP_SERVER`, `CHECK_INTERVAL_SECONDS`).

| Group | Environment variables |
| --- | --- |
| Login (environment only) | `UI_USER`, `UI_PASSWORD` |
| Cloudflare | `CLOUDFLARE_API_TOKEN` (secret; Zone:Read and DNS:Edit), `CLOUDFLARE_PROXIED`, `CLOUDFLARE_IP_SYNC`, `CLOUDFLARE_MOVE_OLD_IP_RECORDS`, `CLOUDFLARE_DNS_FROM_CONFIGS`, `CLOUDFLARE_CHECK_INTERVAL_SECONDS`, `RETRY_INTERVAL_SECONDS`, `CLOUDFLARE_DOMAINS` |
| Public IP lookup | `WHOAMI_URLS`, `OVERRIDE_OBSOLETE_WHOAMI`, `ENFORCE_DNS_RESOLUTION`, `TEST_URL_CONNECTIVITY`, `ENFORCE_URL_CONNECTIVITY`, `ENFORCE_URL_VALIDITY`, `IP_CHANGE_CONFIRM_SECONDS`, `INITIAL_IP` |
| Certificates | `ACME_EMAIL`, `ACME_STAGING` (default on) |
| Email | `SMTP_ENABLED`, `SMTP_HOST`, `SMTP_PORT` (0 = default for the security mode), `SMTP_SECURITY` (`none`, `starttls`, `ssl`), `SMTP_USERNAME`, `SMTP_PASSWORD` (secret), `SMTP_FROM`, `SMTP_TO` (comma separated), `SMTP_REPLY_TO`, `SMTP_UNSUBSCRIBE`, `SMTP_PRECEDENCE`, `SMTP_RETRIES`, `SMTP_RETRY_DELAY` |
| Discord | `DISCORD_WEBHOOK_URL` (secret; several allowed, separated by commas), `DISCORD_USERNAME`, `DISCORD_PING`, `DISCORD_BOLD`, `DISCORD_PREFIX_HEADER`, `USE_EMBEDS` |
| Nginx | `NGINX_AUTO_RELOAD`, `WATCH_CONFIG`, `SEND_DIFF`, `DIFF_CONTEXT`, `INCLUDE_HOSTNAME`, `CUSTOM_HOSTNAME`, `NGINX_AUTOHANDLER_BACKUP_KEEP` |
| General | `SERVICE_NAME`, `DISABLE_WELCOME_EMAIL`, `DISABLE_RESTART_EMAIL`, `LOG_LEVEL`, `MAX_LOG_BYTES`, `ENABLE_COLORED_LOGGING` |

Diffs under about 3000 bytes go inside the Discord embed; larger ones are attached as `nginx-changes.diff`.

## Certificates

Four kinds of certificate sit side by side in the Certificates dialog, all usable from nginx at `/etc/letsencrypt/live/<name>/fullchain.pem` and `privkey.pem` (external ones show their own paths):

- **ACME (Let's Encrypt by default):** issued through DNS-01 with the Cloudflare token, so port 80 doesn't need to be reachable and wildcards work. Each domain needs to be in a zone the token can see. Issuing also creates A records for the names you entered. Every 12 hours the app checks each certificate and renews the ones within `CERT_RENEW_DAYS` of expiry (default 30; set 14 or 7 if you prefer). The Certificates dialog has a Reissue button to get a fresh certificate now, even if the current one is still valid (CAs rate-limit this). Staging is the default; staging certificates are not trusted by browsers.
- **Self-signed:** generated in the container for names or IPs, for 1 to 3650 days. Handy for internal services.
- **Uploaded:** paste or pick a certificate (with its chain) and key. The key must match the certificate, and password-protected keys are refused.
- **External (bind-mounted):** certificates something else manages. Mount a folder at `/certs` (compose has `./data/external-certs:/certs:ro`) or any path and name it in `EXTERNAL_CERT_DIRS` (comma separated). They are listed read-only, with expiry warnings. Layouts understood: `<dir>/<name>/fullchain.pem + privkey.pem` (also `tls.crt`/`tls.key`, `cert.pem`/`key.pem`), and loose `<name>.crt|.pem|.cer` with `<name>.key`.

**Certificate authority.** `ACME_PROVIDER` picks `letsencrypt` (default), `zerossl`, `google` (Google Trust Services) or `custom` (set `ACME_DIRECTORY_URL`). ZeroSSL and Google need External Account Binding keys (`ACME_EAB_KID`, `ACME_EAB_HMAC_KEY`). ZeroSSL and custom servers have no staging service here, so turn staging off for them. Only Cloudflare does the DNS-01 challenge for now (`ACME_DNS_PROVIDER`); the provider is a setting so others can be added.

**Expiry warnings.** Every certificate is checked at start and then every 12 hours. One that expires within `CERT_EXPIRY_WARN_DAYS` days (default 14, 0 turns it off) is reported to Discord and email, at most once a day per certificate.

## Git sync

Set `GIT_REPO_URL` (an `https://` URL, for example a private GitHub repository) and `GIT_TOKEN` (a token with Contents access) in Settings > Git sync, then use the Git sync dialog or set `GIT_INTERVAL_MINUTES` to sync on a timer.

- **Pull** brings the repository's files into the config through the normal apply step: tested with `nginx -t`, reloaded only if it passes, rolled back if not, with a backup in History.
- **Conflicts:** a file edited here since the last sync and also changed in the repository is kept as it is here and reported. `GIT_CONFLICTS=use-repo`, or the "Let the repository win" button, lets the repository win instead.
- **Push** commits changed local files to the branch. It never forces, never deletes files from the repository, and refuses when the repository has commits you have not pulled. Keys and certificates (`*.key`, `*.pem`, `*.crt`, ...) and any file containing a private key are never pushed.
- `GIT_MODE` is `pull` (default), `push` or `both`. `GIT_SUBDIR` picks a folder inside the repository. Nothing is ever deleted from the config folder by a pull.
- Treat the repository as private: configs can contain passwords (for example `auth_basic` or upstream credentials).

## Editing

Every file opens in one of three views:

- **Basic** works like Nginx Proxy Manager: one card per site with its domain names, where it forwards to (an app, a folder or a redirect), and switches for SSL, Force HTTPS, HTTP/2 (on by default), WebSocket support, blocking common exploits, caching assets and HSTS. Anything Basic cannot show stays untouched and is counted as "N more settings".
- **Blocks** is the full editor. Every directive and block can carry a comment on the same line (`listen 443 ssl;  # Listen on https`), and comments stay where they were written. The Blocks tab on the right is the block library: ready-made sections you can drag in. Save your own (from a selection or from scratch) and edit or delete them later; built-in ones can be duplicated.
- **Nginx** is the plain text.

**Save** writes the changes, tests them and reloads, and rolls back if the test fails. **Enabled** turns a config on or off. If the config already failed before your change and every error is in files you did not touch, the change is kept, nginx is not reloaded, and you get an amber notice naming those files.

**Files.** New files and imports default to `conf.d` (any folder can be typed; nginx only loads subfolders if you include them, for example `include /etc/nginx/conf.d/*/*.conf;`). Drop files, a folder or a zip onto a folder in the tree to import there, drag rows to move them, and double-click or press F2 to rename. The **Tasks** button lists what is running in the background (certificate requests, git sync, DNS updates). Only one certificate request runs at a time.

**HTTPS.** Enable HTTPS lets you pick an existing certificate (best fit first), issue a new one, make a self-signed one, point at a certificate folder, or type paths. When a config points at `/etc/letsencrypt/live/<name>/` and that certificate does not exist yet, a name that is one of the site's own names is issued automatically for the site's names; any other name asks what the certificate should contain.

## Experimental: the Lab, the phone view and site features

> This section describes the `experimental/go-ham` branch. Everything here goes through the same test-before-reload step as the editor, so a change nginx rejects is rolled back. It is newer than the rest and less battle-tested.

**Lab** (`/lab`, or the Lab button in the top bar). Keys `1` to `6` switch pages.

- **Status:** requests per hour, response classes, busiest pages and visitors, recent 5xx errors and the nginx error log, from nginx's access log (pick any `*access*.log`). Server health comes from a live `nginx -t`.
- **Sites:** every server block with switches for the advanced settings people look up every time. Each feature is a small form; turning it on adds the nginx it needs (including the zones, caches and upstreams that live one level up) and tags it with a `# feature:<name>` comment so it can be changed or removed cleanly later: rate limit, connection limit, password protection (apr1 hashes stored in the data folder, never in the config or git), IP allow list, security headers, CORS with preflight, gzip, response cache, upload size and timeouts, load balancing over several app servers (round robin, least busy, same visitor), a friendly maintenance error page, and a per-site log file. Plus change domains and target, and turn HTTPS on or off with a certificate picker (HTTPS adds a port 80 redirect by default).
- **Topology:** an SVG map of domains, sites, load-balancing pools and apps. Hover to follow a path, click a site to manage it.
- **Search:** find any line across every config file, including turned-off ones. Plain text or regular expressions.
- **Templates:** one-step new sites: reverse proxy, static site, single-page app, redirect, PHP, load-balanced app, protected API (rate limit, CORS, headers and compression already on), maintenance page, catch-all, and a TCP/UDP proxy (nginx `stream`, written to `stream.d/` with the `include` added to `nginx.conf` for you).
- **Timeline:** every change, rejection and outside edit with its diff, kept across restarts in `timeline.jsonl` in the data folder.
- **Undo:** after a save from the Lab or the phone view, the toast offers Undo, which restores the previous version through the same tested apply.

**Phone view** (`/m`). Phones with a coarse pointer and a narrow screen are sent there automatically; `/?desktop=1` opens the full editor. A bottom bar has Status (health, test, reload, traffic), Sites (turn on or off, change domain and target, HTTPS), Certs (expiry, renew now), Tasks and Logs (filter, follow). Big touch targets, light and dark.

**Command palette.** `Ctrl+K` (or `/` outside a text field) on every page: jump to any page, site or file, test or reload nginx, switch theme, open the editor's dialogs. `/?desktop=1#open=<path>` opens a file in the editor.

New endpoints (all behind the same login and CSRF header): `GET /api/sites`, `POST /api/sites/update|https|https/off`, `GET /api/features`, `POST /api/features/apply|disable`, `GET /api/htpasswd`, `GET /api/templates`, `POST /api/templates/create`, `GET /api/stats`, `GET /api/search`, `GET /api/topology`, `GET /api/timeline`, `GET /api/clock`.

## Turning configs on and off

Home and the file tree can turn a config off. That renames `name.conf` to `name.conf.disabled` (nginx stops loading it), tests the result, reloads, and puts everything back if the test fails. Turning it on renames it back. Nothing is deleted.

## Emails and times

Failures a person needs to know about are sent without being asked for: a rejected deploy (with the nginx error and the diff), nginx not running (a broken config at start-up or a crash, then again when it recovers), certificate warnings and renewal failures, IP changes, and git sync problems.

Times in messages follow `TIME_DISPLAY`: `utc`, `local` (the container's `TZ`) or `both` (default, shown as `2026-11-01 15:02:11 UTC (10:02:11 CDT)`).

Every email (IP changes, config changes, welcome and restart notices, certificate warnings) uses one layout: a dark header with the logo, a status pill, the details, a results list and a colour-coded diff where relevant. HTML and plain-text parts are both sent, and the logo is attached inline, so nothing loads from the internet.

## DNS without dynamic DNS

The DNS dialog lists every managed domain, lets you add or remove them, and has a Set IP box that points them at an address you choose. Removing a domain only stops managing it; the record on Cloudflare is not deleted.

## Logs

The editor shows nginx's access and error logs, this app's log and certbot's. nginx writes real files to `/var/log/nginx` (also copied to the container's output, so `docker logs` still shows them; compose mounts `./data/logs`). Files over 20 MB are rotated, keeping one old copy. Only those log files can be read.

## Safety and drop-in use

The image is built on `nginx:1.27-alpine` and keeps its start-up scripts (`/docker-entrypoint.d`, envsubst templates, IPv6, worker tuning), its ports and its paths. Swap it in where you use the stock image, mount your config at `/etc/nginx`, and you get the editor, auto-reload, DNS and certificates on top.

**nginx comes first.**
- nginx is the main process and gets the signals (`docker stop` sends a graceful quit, `SIGHUP` reloads, `SIGUSR1` reopens logs).
- The editor runs next to it at a lower CPU priority and is the first thing the out-of-memory killer takes. If it stops, it restarts after 3 seconds and nginx is untouched.
- If nginx fails to start because of a broken config, the container stays up and nginx is started again every 5 seconds, so you can fix the config in the editor. Set `NGINX_EXIT_ON_FAILURE=true` for the stock behaviour (the container exits instead).
- `AUTOHANDLER_DISABLED=true` runs the image as plain nginx, with no editor.
- The container reports healthy while nginx is running.

**It does not delete or break your files.**
- An empty `/etc/nginx` is seeded with the default config once. Existing files are never replaced.
- Every save is written in one step (a temp file renamed over the old one), keeps the file's mode and owner, and keeps its line endings. A single-file bind mount that cannot be renamed over is rewritten in place.
- Every change is tested with `nginx -t` first and reloaded only if it passes. If the test or the reload fails, every file goes back to how it was, deleted ones included. A snapshot of each changed file is kept (`NGINX_AUTOHANDLER_BACKUP_KEEP`, default 4), and History restores any of them.
- Files are deleted only when you delete them in the editor, and `nginx.conf` cannot be deleted. Turning a config off renames it to `name.conf.disabled`, it never removes it.
- The watcher never writes to your config. It reads, tests and reloads, and keeps its last-known-good copies in its own folder.
- Certificates: nothing is deleted unless you press Delete. Let's Encrypt ones go through certbot so they stop renewing cleanly, and bind-mounted (external) ones are read-only.
- DNS: only the domains in your configs and the DNS dialog are touched. With `CLOUDFLARE_MOVE_OLD_IP_RECORDS` on (the updater's behaviour), every A record on the old IP follows a changed IP, so a changed address must be reported again after `IP_CHANGE_CONFIRM_SECONDS` (default 5) before anything moves. A flip between a private and a public address is refused. Turn the option off to limit changes to your own domains.
- nginx logs are rotated at 20 MB (`NGINX_LOG_ROTATE_BYTES`, 0 turns it off), keeping one old copy.

**The editor can change nginx's config, so protect it.** Set `UI_PASSWORD`, or keep it behind an authenticating proxy, or set `UI_BIND=127.0.0.1` to keep it off the network. Don't publish its port to the internet without TLS in front.

## Layout

| File | Purpose |
| --- | --- |
| `server.py` | HTTP server, file API, apply and rollback, DNS sync loop |
| `nginx_model/` | Vendored from `nginx_attempt2`: the lossless parser, renderer, editing and validation |
| `settings.py` | Settings and secrets, environment precedence, write-only secrets |
| `notify.py` | Discord and SMTP notifications |
| `certs.py` | certbot wrapper for DNS-01 issue and renewal, certificate folders |
| `tasks.py` | The list of running and finished background jobs |
| `sites.py`, `features.py`, `htpasswd.py`, `templates.py` | Experimental: sites as data, the feature catalogue, password files, site templates |
| `stats.py`, `explore.py`, `timeline.py` | Experimental: access-log statistics, search and topology, the persistent timeline |
| `recipes.py` | The user's saved blocks (block library) |
| `cloudflare.py` | Cloudflare API client: zones, A records, moving records between IPs, retries |
| `whoami.py` | Public IP lookup through whoami URLs (Traefik whoami format or a bare IP) |
| `ipsync.py` | The cloudflare_updater behaviour: IP change detection, record moves, welcome and restart mail |
| `overview.py` | The home page data: enabled and disabled configs, sites, domains, certificate expiry |
| `logs.py` | Log listing, tailing and rotation |
| `watcher.py` | The nginx-reloading behaviour: watches the config folder, tests, reloads, reports with diffs |
| `static/` | Editor UI: plain HTML, CSS and JS, no build step |
| `entrypoint.sh` | Seeds the config, starts the app, runs nginx in the foreground |
| `tests/` | `python tests/test_autohandler.py`. The vendored suites run with `python -m unittest nginx_model.tests.test_toolkit nginx_model.tests.test_editing` |

## Notes

- The app runs as root, like nginx. Anyone who can reach the UI can change nginx config, so keep it behind login or a proxy.
- Cloudflare calls: `GET /zones` (paginated) finds the zone, then `GET /zones/{id}/dns_records` finds the record, then `POST` or `PATCH` writes it. 429 and 5xx responses are retried with backoff.
- `nginx_model/` also has import, export, include-graph and JSON storage features. The editor uses only parse and render so far.
