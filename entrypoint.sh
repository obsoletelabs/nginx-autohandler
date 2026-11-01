#!/bin/sh
set -eu

# A bind-mounted, empty /etc/nginx gets the image's default config.
if [ -z "$(ls -A /etc/nginx 2>/dev/null)" ]; then
  cp -a /etc/nginx.default/. /etc/nginx/
fi

python3 /app/server.py &

exec nginx -g 'daemon off;'
