# nginx-autohandler

A single container that runs nginx with a web editor for its config, plus Cloudflare DNS sync.

- **Files:** browse, view, edit, create and delete under `/etc/nginx`.
- **Raw and Blocks editors:** edit the text directly, or use the block view to edit directives and nested blocks like `server`, `location` and `upstream`. The block view keeps comments and anything it doesn't model, so the file round-trips byte for byte when you don't change it.
- **Safe apply:** every save writes the file, runs `nginx -t` on the whole config and reloads if auto-reload is on. If the test or reload fails, the previous file is put back and the editor keeps your text.
- **Backups:** each change snapshots the old file. The last 4 per file are kept (`NGINX_AUTOHANDLER_BACKUP_KEEP`). The History dialog restores any of them.
- **Cloudflare:** a `server_name` saved in a config gets an A record pointing at this host. Tracked domains are kept current on a timer (`CLOUDFLARE_IP_SYNC`).
- **Login is optional:** set `UI_PASSWORD` for basic auth, or leave it empty when a proxy handles login.

## Run it

```bash
cp .env.example .env
docker compose up -d --build
```

- Editor: http://localhost:8080 (listens on all interfaces; put your TLS reverse proxy in front for remote access)
- nginx: ports 80 and 443
- Config lives in `./data/nginx`. An empty directory is seeded with the image's default config on first start.
- UI state and backups live in `./data/ui`.

## Layout

| File | Purpose |
| --- | --- |
| `server.py` | HTTP server, file API, apply/rollback, DNS sync loop |
| `nginx_config.py` | Lossless parser and renderer for the block editor, plus `server_name` extraction |
| `cloudflare.py` | Cloudflare API client: zones, A records, retries, public IP |
| `static/` | Editor UI (plain HTML, CSS and JS, no build step) |
| `entrypoint.sh` | Seeds the config, starts the UI, runs nginx in the foreground |
| `tests/` | Parser tests: `python3 tests/test_nginx_config.py` |

## Notes

- The editor runs as root, like nginx. Anyone who can reach it can change nginx config, so don't expose it without login or a proxy in front.
- Cloudflare: `GET /zones` (paginated) finds the zone, `GET /zones/{id}/dns_records` finds the record, then `POST` or `PATCH` writes it. 429 and 5xx responses are retried with backoff.
- The block editor is the "visual" editor from [obsoletelabs/special-fiesta#68](https://github.com/obsoletelabs/special-fiesta/issues/68). It is private, so the link works only for members of the org.
