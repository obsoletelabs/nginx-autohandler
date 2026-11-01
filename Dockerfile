FROM nginx:1.27-alpine

RUN apk add --no-cache python3 openssl tzdata git certbot certbot-dns-cloudflare \
    && cp -a /etc/nginx /etc/nginx.default \
    && rm -f /var/log/nginx/access.log /var/log/nginx/error.log \
    && mkdir -p /app /var/lib/nginx-autohandler /certs

COPY server.py cloudflare.py certs.py notify.py settings.py workshop.py ipsync.py whoami.py watcher.py logs.py overview.py mailtemplate.py gitsync.py entrypoint.sh /app/
COPY nginx_model /app/nginx_model
COPY static /app/static
RUN chmod +x /app/entrypoint.sh

ENV NGINX_CONF_ROOT=/etc/nginx \
    NGINX_AUTOHANDLER_DATA=/var/lib/nginx-autohandler \
    UI_PORT=8080

EXPOSE 80 443 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD pidof nginx >/dev/null || exit 1

CMD ["/app/entrypoint.sh"]
