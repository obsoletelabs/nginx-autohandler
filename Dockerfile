FROM nginx:1.27-alpine

RUN apk add --no-cache python3 \
    && cp -a /etc/nginx /etc/nginx.default \
    && mkdir -p /app /var/lib/nginx-ui

COPY server.py cloudflare.py nginx_config.py entrypoint.sh /app/
COPY static /app/static
RUN chmod +x /app/entrypoint.sh

ENV NGINX_CONF_ROOT=/etc/nginx \
    NGINX_UI_DATA=/var/lib/nginx-ui \
    UI_PORT=8080

EXPOSE 80 443 8080

CMD ["/app/entrypoint.sh"]
