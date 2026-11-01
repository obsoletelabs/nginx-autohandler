"""Cloudflare DNS helpers.

Follows the approach of obsoletelabs/cloudflare_updater: paginated zone lookup,
retries with backoff on 429 and 5xx, a public-IP check with fallbacks, and
A-record create or update. Standard library only.
"""

import ipaddress
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.cloudflare.com/client/v4"
IP_URLS = ["https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"]

log = logging.getLogger("nginx-autohandler.cloudflare")


class CloudflareError(RuntimeError):
    pass


def public_ip():
    """This host's public IPv4 address, from the first URL that answers."""
    last_error = None
    for url in IP_URLS:
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                ip = resp.read().decode("utf-8").strip()
            address = ipaddress.IPv4Address(ip)
            if address.is_unspecified or address.is_private:
                raise ValueError(f"{url} returned a non-public address: {ip}")
            return str(address)
        except (OSError, ValueError) as exc:
            last_error = exc
            log.warning("public IP lookup via %s failed: %s", url, exc)
    raise CloudflareError(f"could not detect public IP: {last_error}")


class Cloudflare:
    def __init__(self, token, proxied=False):
        self.token = token
        self.proxied = proxied
        self._zones = None

    def request(self, method, path, params=None, body=None, retries=5):
        url = API + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        backoff = 1.0
        for attempt in range(1, retries + 1):
            req = urllib.request.Request(
                url,
                data=data,
                method=method,
                headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    payload = json.load(resp)
                if not payload.get("success", False):
                    raise CloudflareError(f"{method} {path}: {payload.get('errors')}")
                return payload
            except urllib.error.HTTPError as exc:
                if exc.code == 429 or exc.code >= 500:
                    if attempt == retries:
                        break
                    wait = _retry_after(exc) or backoff
                    log.warning("Cloudflare HTTP %s on %s, retrying in %.1fs", exc.code, path, wait)
                    time.sleep(wait)
                    backoff *= 2
                    continue
                raise CloudflareError(f"{method} {path}: HTTP {exc.code} {_error_text(exc)}") from exc
            except urllib.error.URLError as exc:
                if attempt == retries:
                    raise CloudflareError(f"{method} {path}: {exc.reason}") from exc
                time.sleep(backoff)
                backoff *= 2
        raise CloudflareError(f"{method} {path}: gave up after {retries} attempts")

    def zones(self):
        if self._zones is None:
            zones, page = {}, 1
            while True:
                data = self.request("GET", "/zones", params={"page": page, "per_page": 50})
                for zone in data["result"]:
                    zones[zone["name"]] = zone["id"]
                if page >= data["result_info"]["total_pages"]:
                    break
                page += 1
            self._zones = zones
        return self._zones

    def zone_id_for(self, hostname):
        """Zone that contains `hostname`: tries a.b.example.com, then b.example.com, then example.com."""
        zones = self.zones()
        labels = hostname.split(".")
        for i in range(len(labels) - 1):
            zone_id = zones.get(".".join(labels[i:]))
            if zone_id:
                return zone_id
        raise CloudflareError(f"no zone for {hostname} is visible to this token")

    def set_a(self, hostname, ip):
        """Make `hostname` an A record pointing at `ip`. Returns created, updated or unchanged."""
        zone_id = self.zone_id_for(hostname)
        records = self.request(
            "GET", f"/zones/{zone_id}/dns_records", params={"type": "A", "name": hostname, "per_page": 100}
        )["result"]
        body = {"type": "A", "name": hostname, "content": ip, "ttl": 1, "proxied": self.proxied}
        if not records:
            self.request("POST", f"/zones/{zone_id}/dns_records", body=body)
            return "created"
        record = records[0]
        if record["content"] == ip and record["proxied"] == self.proxied:
            return "unchanged"
        self.request("PATCH", f"/zones/{zone_id}/dns_records/{record['id']}", body=body)
        return "updated"


def _retry_after(exc):
    try:
        return float(exc.headers.get("Retry-After"))
    except (TypeError, ValueError):
        return None


def _error_text(exc):
    try:
        return json.load(exc).get("errors")
    except (ValueError, OSError):
        return ""
