"""Finding this host's public IP through whoami endpoints.

Works like obsoletelabs/cloudflare_updater: a list of URLs is tried in order and the
first one that answers wins. A URL may answer in the format of the Traefik "whoami"
container (lines such as `Name:`, `RemoteAddr:` and `X-Forwarded-For:`) or with a bare
IP address as plain text. X-Forwarded-For wins over RemoteAddr when both are present.

The URL list is checked once when it is first used (and again if the settings change),
using the same switches as the updater: ENFORCE_DNS_RESOLUTION, TEST_URL_CONNECTIVITY,
ENFORCE_URL_CONNECTIVITY and ENFORCE_URL_VALIDITY.
"""

import ipaddress
import logging
import socket
import threading
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit

import settings

log = logging.getLogger("nginx-autohandler.whoami")

OBSOLETE_URLS = ["http://whoami.obsoletelabs.org:12345/", "http://whoami.obsoletelabs.net:12345/"]
PUBLIC_SERVICES = ["https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"]
TIMEOUT = 5

_cache = {"signature": None, "urls": []}
_lock = threading.Lock()


def valid_ip(value):
    """The canonical text of an IP address, or None."""
    try:
        return str(ipaddress.ip_address(str(value).strip()))
    except ValueError:
        return None


def is_private(ip):
    try:
        return not ipaddress.ip_address(ip).is_global  # private, link-local, CGNAT (Tailscale), documentation ranges
    except ValueError:
        return False


def _host_of(address):
    """`1.2.3.4:5678` or `[::1]:5678` to the bare host."""
    address = address.strip()
    if address.startswith("["):
        return address[1:].split("]", 1)[0]
    if address.count(":") == 1:
        return address.split(":", 1)[0]
    return address


def parse_response(text):
    """(ip, name) from a whoami reply, or (None, None) when it holds no usable address."""
    name = remote = forwarded = None
    for line in text.splitlines():
        key, separator, value = line.partition(":")
        if not separator:
            continue
        key, value = key.strip().lower(), value.strip()
        if key == "name" and value:
            name = value
        elif key == "remoteaddr":
            remote = remote or valid_ip(_host_of(value))
        elif key == "x-forwarded-for":
            forwarded = forwarded or valid_ip(value.split(",")[0])
    ip = forwarded or remote
    if ip:
        return ip, name
    bare = valid_ip(text)
    return (bare, name) if bare else (None, None)


def fetch(url):
    """Ask one URL. Returns (ip, name); ip is None when the reply holds no address. Network errors raise OSError."""
    request = urllib.request.Request(url, headers={"User-Agent": "nginx-autohandler"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        text = response.read(65536).decode("utf-8", "replace")
    return parse_response(text)


def _resolves(host):
    try:
        socket.gethostbyname(host)
        return True
    except OSError:
        return False


def validate_url(raw):
    """The usable form of a configured URL, or None when it is dropped. Mirrors the updater's checks."""
    enforce_dns = settings.get("enforce_dns_resolution")
    test = settings.get("test_url_connectivity")
    enforce_connectivity = settings.get("enforce_url_connectivity")
    enforce_validity = settings.get("enforce_url_validity")

    explicit_scheme = "://" in raw
    parts = urlsplit(raw if explicit_scheme else "http://" + raw)
    host = parts.hostname
    if not host:
        log.error("whoami URL %s has no host name", raw)
        return None
    is_literal = valid_ip(host) is not None
    if not is_literal:
        if "." not in host:
            log.error("whoami URL %s dropped: no valid top-level domain", raw)
            return None
        if not _resolves(host):
            if enforce_dns:
                log.error("whoami URL %s dropped: %s does not resolve", raw, host)
                return None
            log.warning("whoami host %s does not resolve right now", host)

    schemes = [parts.scheme] if explicit_scheme else (["http"] if is_literal else ["https", "http"])
    if explicit_scheme and not is_literal:
        schemes.append("https" if parts.scheme == "http" else "http")
    candidates = [urlunsplit((scheme,) + tuple(parts[1:])) for scheme in schemes]
    if not test:
        return candidates[0]

    for candidate in candidates:
        try:
            ip, _ = fetch(candidate)
        except OSError:
            continue
        if ip:
            log.info("whoami URL %s answered with %s", candidate, ip)
            return candidate
        if enforce_validity:
            log.error("whoami URL %s dropped: it answered without an IP address", candidate)
            return None
        log.warning("whoami URL %s answered without an IP address", candidate)
        return candidate
    if enforce_connectivity:
        log.error("whoami URL %s dropped: could not connect", raw)
        return None
    log.warning("whoami URL %s could not be reached; keeping it for later", raw)
    return candidates[0]


def configured():
    """The raw list: the user's URLs, then the obsoletelabs fallbacks unless they are switched off."""
    urls = [item.strip() for item in settings.get("whoami_urls").split(",") if item.strip()]
    if not settings.get("override_obsolete_whoami"):
        urls += OBSOLETE_URLS
    return urls


def urls():
    """Validated whoami URLs, in order. Falls back to public lookup services when none survive."""
    raw = configured()
    signature = (tuple(raw),) + tuple(settings.get(key) for key in (
        "enforce_dns_resolution", "test_url_connectivity", "enforce_url_connectivity", "enforce_url_validity"))
    with _lock:
        if _cache["signature"] == signature:
            return list(_cache["urls"])
    usable = []
    for item in raw:
        checked = validate_url(item)
        if checked and checked not in usable:
            usable.append(checked)
    if not usable:
        log.warning("no usable whoami URL is configured; using public IP lookup services")
        usable = list(PUBLIC_SERVICES)
    with _lock:
        _cache.update(signature=signature, urls=usable)
    return list(usable)


def lookup():
    """(ip, source) from the first URL that answers, or (None, None)."""
    first = True
    for url in urls():
        log.info("%s IP via %s", "Checking" if first else "Failover: checking", url)
        first = False
        try:
            ip, name = fetch(url)
        except OSError as exc:
            log.warning("whoami %s failed: %s", url, exc)
            continue
        if ip:
            return ip, name or url
        log.warning("whoami %s answered without an IP address", url)
    log.warning("no whoami URL answered")
    return None, None
