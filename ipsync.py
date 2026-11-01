"""Keeps Cloudflare DNS on this host's public IP: the job of obsoletelabs/cloudflare_updater.

Each run asks the whoami URLs for the current IP and compares it with the one remembered
in the persistent file. When it changed:

  * every A record that pointed at the old IP is moved to the new one, in every zone the
    token can see (records on other addresses are left alone, so one domain can be shared
    by several hosts)
  * the domains found in the configs and the ones added in the UI are pointed at it too
  * Discord and email are told what happened

The first run on a fresh install sends a welcome email, later starts send a restart notice
(both can be switched off). If the address flips between private and public the update is
refused and an email explains why, as the updater does.
"""

import logging
import os
import threading
import time
from pathlib import Path

import cloudflare
import notify
import settings
import whoami

log = logging.getLogger("nginx-autohandler.ipsync")

PERSISTENT_FILE = Path(os.environ.get("PERSISTENT_FILE_PATH") or settings.DATA_DIR / "persistent_ip.txt")


def read_persistent():
    try:
        return PERSISTENT_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def write_persistent(ip):
    try:
        PERSISTENT_FILE.parent.mkdir(parents=True, exist_ok=True)
        PERSISTENT_FILE.write_text(ip, encoding="utf-8")
    except OSError as exc:
        log.error("could not write the persistent IP file: %s", exc)


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


class IpSync:
    def __init__(self, get_client, wanted_domains, remember):
        """get_client: Cloudflare client or None. wanted_domains: callable returning the domains to keep.
        remember: callable(domains, ip) that records what was synced."""
        self.get_client = get_client
        self.wanted_domains = wanted_domains
        self.remember = remember
        self.lock = threading.Lock()
        self.old_ip = None
        self.status = {"last_run": None, "ip": None, "previous_ip": None, "source": None, "results": {}, "error": None}

    # ------------------------------------------------------------ start up

    def _start_up(self, detected):
        """First contact after the process starts: pick the IP to compare with, send welcome or restart mail."""
        notes = []
        persistent = read_persistent()
        initial = settings.get("initial_ip").strip()
        first_ever = persistent == ""
        urls = whoami.urls()
        notes.append(f"INFO: Using WHOAMI_URLS: {urls}")
        if not first_ever:
            old = persistent
            notes.append("INFO: Previous IP found in persistent storage.")
        elif initial:
            old = initial
            notes.append("WARNING: Initial IP overwritten by debug value. (Not recommended for production use)")
        else:
            old = detected
        notes.append(f"INFO: Initial IP set to: {old}")
        if whoami.is_private(old):
            notes.append(f"WARNING: The initial IP address {old} appears to be a local/private IP address. This may "
                         "indicate a misconfiguration or an issue with retrieving the public IP address. Please verify "
                         "your network settings and ensure that the whoami URLs are correctly configured to return "
                         "the public IP address.")
        notes.append(f"INFO: Service name set to: {notify.service_name()}")
        if notify.smtp_ready():
            notes.append("INFO: SMTP Notifier is enabled.")
        log.info("Initial IP set to %s (%s)", old, "first run" if first_ever else "restart")
        self.old_ip = old
        name = notify.service_name()
        if first_ever:
            write_persistent(old)  # so the next start is recognised as a restart even if the IP never changes
            if not settings.get("disable_welcome_email"):
                notify.fire(notify.email, {
                    "Subject": "Welcome to your obsoletelabs future, cloudflare dynamic-dns style!",
                    "Title": "Welcome to your obsoletelabs future",
                    "Status": "info",
                    "Lead": ("Hey there! Welcome! We are happy to have you join us in our cloudflare mayhem.\n\n"
                             "Currently we have a key personell on holiday, and these startup emails require him to "
                             "return back to the office, so we will have to give you an idea of what could be to come "
                             "in our obsolete future.\n\nBest of luck, worst of luck, heres to your obsoletelabs future!"),
                    "Facts": [("Public IP", old), ("Service", name)],
                    "Notes": notes,
                    "Preheader": "Your service has started. Here are the startup notes.",
                })
        elif not settings.get("disable_restart_email"):
            notify.fire(notify.email, {
                "Subject": "Notice of Service Restart for " + name,
                "Title": "Service restarted",
                "Status": "info",
                "Lead": "Your cloudflare updater service has restarted. Please see the startup notes for more information.",
                "Facts": [("Public IP", old), ("Service", name)],
                "Notes": notes,
                "Preheader": "The service restarted. Startup notes inside.",
            })

    # ------------------------------------------------------------ one pass

    def run(self):
        """Check the IP and bring DNS in line. Returns the status dict (also kept in self.status)."""
        client = self.get_client()
        if client is None:
            return {"error": "Cloudflare API token is not set"}
        with self.lock:
            status = {"last_run": _now(), "ip": None, "previous_ip": self.old_ip, "source": None, "results": {},
                      "error": None}
            try:
                ip, source = whoami.lookup()
                if ip is None:
                    status["error"] = "no whoami URL answered"
                    return self._finish(status)
                if self.old_ip is None:
                    self._start_up(ip)
                    status["previous_ip"] = self.old_ip
                if ip != self.old_ip:
                    ip, source = self._confirm(ip, source)
                    if ip is None:
                        status["error"] = "a changed IP was not confirmed on the second check, so nothing was changed"
                        return self._finish(status)
                ip = self._guard_type_change(self.old_ip, ip, source)
                status.update(ip=ip, source=source)
                status["results"] = self._sync(client, self.old_ip, ip, source)
            except cloudflare.CloudflareError as exc:
                log.error("DNS sync failed: %s", exc)
                status["error"] = str(exc)
            except Exception as exc:  # the loop must survive; the UI shows the error
                log.exception("DNS sync failed")
                status["error"] = str(exc)
            return self._finish(status)

    def _confirm(self, ip, source):
        """A different address must be reported again after a short wait before DNS follows it, so one bad
        answer (a VPN, a broken whoami) cannot repoint every record."""
        wait = settings.get("ip_change_confirm_seconds")
        if wait <= 0:
            return ip, source
        log.info("whoami reports a new IP %s; checking again in %ss before acting", ip, wait)
        time.sleep(wait)
        again, again_source = whoami.lookup()
        if again == ip:
            return ip, again_source or source
        log.warning("the IP answer changed from %s to %s on the second check; ignoring both", ip, again)
        return None, None

    def _finish(self, status):
        self.status = status
        return status

    def _guard_type_change(self, old, new, source):
        """Refuse to switch between a private and a public address; keep the old one."""
        if whoami.is_private(new) == whoami.is_private(old):
            return new
        kind = lambda ip: "local/private" if whoami.is_private(ip) else "public"  # noqa: E731
        message = (f"whoami service {source} reported an IP address type change from {kind(old)} ({old}) to "
                   f"{kind(new)} ({new}).")
        log.error("%s Update aborted; keeping %s.", message, old)
        notify.fire(notify.email, {
            "Subject": f"IP Address Type Change Detected for {notify.service_name()}",
            "Title": "IP address type change detected",
            "Status": "bad",
            "Lead": (f"{message}\n\nThe update was aborted to prevent a misconfiguration, and the previous IP address "
                     f"({old}) is kept.\n\nIf this keeps happening, check your network settings and make sure the whoami "
                     "URLs return the type of IP address you expect. You may need to set (or remove) the INITIAL_IP "
                     "setting."),
            "Facts": [("Kept", old), ("Rejected", new), ("Reported by", str(source))],
        })
        return old

    def _sync(self, client, old, new, source):
        changed = new != old
        moved = {}
        if changed:
            log.warning("IP change detected: %s --> %s", old, new)
            if settings.get("cloudflare_move_old_ip_records"):
                try:
                    moved = client.replace_ip(old, new)
                except cloudflare.CloudflareError as exc:
                    log.error("moving records failed: %s", exc)
                    moved = {"Error": f"error: {exc}"}
        results = dict(moved)
        wanted = set(self.wanted_domains())
        for domain in sorted(wanted):
            if moved.get(domain) == "updated":
                continue
            try:
                results[domain] = client.set_a(domain, new)
            except cloudflare.CloudflareError as exc:
                log.error("DNS for %s failed: %s", domain, exc)
                results[domain] = f"error: {exc}"
        self.remember(wanted, new)

        interesting = {name: outcome for name, outcome in results.items() if outcome != "unchanged"}
        if changed:
            notify.fire(notify.ip_changed, old, new, source, interesting)
            self.old_ip = new
            write_persistent(new)
            log.info("Updated IP address to: %s", new)
        elif interesting:
            self._announce(new, interesting)
        return results

    def _announce(self, ip, interesting):
        """No IP change, but records were created, changed or failed (new domains, edits)."""
        failed = sorted(name for name, outcome in interesting.items() if str(outcome).startswith("error"))
        done = sorted(name for name in interesting if name not in failed)
        subject = (f"DNS updated for {len(done)} domain(s)" if done else f"DNS sync failed for {len(failed)} domain(s)")
        lines = [f"Public IP: {ip}"] + [f"{name}: {interesting[name]}" for name in done + failed]
        notify.fire(notify.send, subject, "\n".join(lines))
