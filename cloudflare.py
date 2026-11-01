"""Cloudflare DNS helpers.

Follows the approach of obsoletelabs/cloudflare_updater: paginated zone lookup,
retries with backoff on 429 and 5xx, a public-IP check with fallbacks, and
A-record create or update, and moving every record from an old IP to a new one.
Standard library only.
"""

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.cloudflare.com/client/v4"

log = logging.getLogger("nginx-autohandler.cloudflare")


class CloudflareError(RuntimeError):
    pass


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

    def verify(self):
        """Is the token valid and active? Returns (ok, message)."""
        try:
            data = self.request("GET", "/user/tokens/verify", retries=2)
        except CloudflareError as exc:
            return False, str(exc)
        status = (data.get("result") or {}).get("status")
        return status == "active", f"token status: {status}"

    def a_records(self, zone_id):
        """Every A record in a zone, across pages."""
        records, page = [], 1
        while True:
            data = self.request("GET", f"/zones/{zone_id}/dns_records",
                                params={"type": "A", "page": page, "per_page": 100})
            records.extend(data["result"])
            if page >= data["result_info"]["total_pages"]:
                return records
            page += 1

    def replace_ip(self, old_ip, new_ip):
        """Point every A record that holds `old_ip` at `new_ip`, in every zone the token can see.

        Only records with the old address change, so several hosts can share a domain.
        TTL and the proxy flag of each record are kept. Returns {name: "updated" | "error: ..."}.
        """
        if not new_ip or new_ip == "0.0.0.0":
            raise CloudflareError("refusing to point records at 0.0.0.0")
        self._zones = None  # zones may have been added since the last look
        results = {}
        for zone_name, zone_id in sorted(self.zones().items()):
            try:
                records = self.a_records(zone_id)
            except CloudflareError as exc:
                log.warning("skipping zone %s: %s", zone_name, exc)
                results[f"zone {zone_name}"] = f"error: {exc}"
                continue
            for record in records:
                if record["content"] != old_ip:
                    continue
                ttl = record.get("ttl", 1)
                body = {"type": "A", "name": record["name"].strip(), "content": new_ip,
                        "ttl": ttl if ttl >= 120 else 1, "proxied": bool(record.get("proxied"))}
                try:
                    self.request("PUT", f"/zones/{zone_id}/dns_records/{record['id']}", body=body)
                    results[record["name"]] = "updated"
                    log.info("[%s] %s: %s -> %s", zone_name, record["name"], old_ip, new_ip)
                except CloudflareError as exc:
                    results[record["name"]] = f"error: {exc}"
        return results

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
        if record.get("ttl", 1) >= 120:
            body["ttl"] = record["ttl"]  # keep a TTL somebody set on purpose
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
