FROM nginx:1.27-alpine

RUN apk add --no-cache python3 \
    && cp -a /etc/nginx /etc/nginx.default \
    && mkdir -p /app /var/lib/nginx-autohandler

COPY server.py cloudflare.py nginx_config.py entrypoint.sh /app/
COPY static /app/static
RUN chmod +x /app/entrypoint.sh

ENV NGINX_CONF_ROOT=/etc/nginx \
    NGINX_AUTOHANDLER_DATA=/var/lib/nginx-autohandler \
    UI_PORT=8080

EXPOSE 80 443 8080

CMD ["/app/entrypoint.sh"]
