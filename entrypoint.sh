#!/bin/sh
# nginx first, the editor second.
#
# nginx is the main process. The editor runs beside it at a lower priority, is restarted if it
# ever stops, and can never stop nginx from running. The image's own start-up scripts
# (envsubst templates, IPv6, worker tuning) still run, so this works as a drop-in nginx image.
#
#   AUTOHANDLER_DISABLED=true    run as a plain nginx image, no editor
#   NGINX_EXIT_ON_FAILURE=true   exit when nginx exits (the stock behaviour). By default nginx is
#                                started again every 5 seconds, so a broken config can still be
#                                fixed from the editor instead of killing the container.
set -u

log() { echo "[autohandler] $*"; }

# A bind-mounted, empty /etc/nginx gets the image's default config. Existing files are never touched.
if [ -z "$(ls -A /etc/nginx 2>/dev/null)" ]; then
  cp -a /etc/nginx.default/. /etc/nginx/
fi

# nginx writes real log files so the editor can read them; they are copied to the container output too.
mkdir -p /var/log/nginx
touch /var/log/nginx/access.log /var/log/nginx/error.log

if [ "${AUTOHANDLER_DISABLED:-false}" = "true" ]; then
  log "editor disabled: running as plain nginx"
  exec /docker-entrypoint.sh nginx -g 'daemon off;'
fi

# Run the stock start-up scripts once, followed by a config test.
/docker-entrypoint.sh nginx -t || log "WARNING: the nginx config does not pass its test. nginx keeps retrying; fix it in the editor."

tail -n 0 -F /var/log/nginx/access.log &
tail -n 0 -F /var/log/nginx/error.log >&2 &

# The editor: lowest priority, first in line for the out-of-memory killer, restarted if it stops.
(
  while :; do
    sh -c 'echo 500 > /proc/self/oom_score_adj 2>/dev/null; exec nice -n 10 python3 /app/server.py'
    log "the editor stopped; restarting in 3 seconds (nginx is unaffected)"
    sleep 3
  done
) </dev/null &

stopping=0
NGINX=""
forward() {
  [ -n "$NGINX" ] && kill -"$1" "$NGINX" 2>/dev/null
}
trap 'stopping=1; forward QUIT' TERM INT QUIT
trap 'forward HUP' HUP
trap 'forward USR1' USR1

while [ "$stopping" = 0 ]; do
  nginx -g 'daemon off;' &
  NGINX=$!
  wait "$NGINX"
  code=$?
  while [ "$code" -gt 128 ] && kill -0 "$NGINX" 2>/dev/null; do  # a forwarded signal interrupted wait
    wait "$NGINX"
    code=$?
  done
  NGINX=""
  [ "$stopping" = 1 ] && exit "$code"
  if [ "${NGINX_EXIT_ON_FAILURE:-false}" = "true" ]; then
    log "nginx exited with status $code"
    exit "$code"
  fi
  log "nginx exited with status $code; starting it again in 5 seconds"
  sleep 5 &
  wait $!
done
