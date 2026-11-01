"""Let's Encrypt certificates via certbot, using the DNS-01 challenge on Cloudflare.

DNS-01 is the only challenge that can issue wildcard certificates, and it does
not need port 80 reachable from the internet. Certificates live under
/etc/letsencrypt, which compose mounts from ./data/certs.
"""

import logging
import os
import re
import subprocess
import threading
import time

import settings

log = logging.getLogger("nginx-autohandler.certs")

CONFIG_DIR = "/etc/letsencrypt"
STATE_DIR = settings.DATA_DIR / "certbot"
CREDENTIALS = STATE_DIR / "cloudflare.ini"
HOST_RE = re.compile(r"^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$")
_renew_lock = threading.Lock()


class CertError(ValueError):
    pass


def _certbot(args, timeout=900):
    cmd = [
        "certbot", *args,
        "--config-dir", CONFIG_DIR,
        "--work-dir", str(STATE_DIR / "work"),
        "--logs-dir", str(STATE_DIR / "logs"),
        "--non-interactive",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def write_credentials():
    """Write the Cloudflare token where certbot can read it on every renewal."""
    token = settings.get("cloudflare_api_token")
    if not token:
        raise CertError("Cloudflare API token is not set")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(CREDENTIALS, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(f"dns_cloudflare_api_token = {token}\n")
    return CREDENTIALS


def validate_domains(domains):
    clean = []
    for raw in domains:
        name = raw.strip().lower()
        if not name:
            continue
        if not HOST_RE.match(name):
            raise CertError(f"not a valid hostname: {raw}")
        clean.append(name)
    if not clean:
        raise CertError("enter at least one domain")
    return sorted(set(clean))


def cert_name(domains):
    first = domains[0].replace("*.", "wildcard.")
    return first


def issue(domains, email, staging):
    """Issue or expand a certificate for `domains`. Returns (ok, output)."""
    domains = validate_domains(domains)
    if not email:
        raise CertError("set the Let's Encrypt contact email first")
    creds = write_credentials()
    args = [
        "certonly", "--agree-tos", "--email", email,
        "--dns-cloudflare", "--dns-cloudflare-credentials", str(creds),
        "--dns-cloudflare-propagation-seconds", "30",
        "--cert-name", cert_name(domains),
        "--deploy-hook", "nginx -s reload",
    ]
    if staging:
        args.append("--staging")
    for name in domains:
        args += ["-d", name]
    ok, output = _certbot(args)
    log.info("certbot issue %s: %s", domains, "ok" if ok else "failed")
    return ok, output


def list_certificates():
    _, output = _certbot(["certificates"], timeout=120)
    return output


def renew_all():
    """Renew anything close to expiry. Quiet when nothing is due."""
    if not settings.get("cloudflare_api_token") or not CREDENTIALS.exists():
        return None
    with _renew_lock:
        ok, output = _certbot(["renew", "--deploy-hook", "nginx -s reload"], timeout=1200)
    return ok, output


def renew_loop(notify):
    """Check for renewals every 12 hours. Notify only on failure or when something renewed."""
    while True:
        time.sleep(12 * 3600)
        try:
            result = renew_all()
            if result is None:
                continue
            ok, output = result
            if not ok:
                notify("certificate renewal failed", output)
            elif "Congratulations" in output:
                notify("certificates renewed", output)
        except Exception as exc:  # the loop must survive
            log.exception("renewal check failed")
            notify("certificate renewal check crashed", str(exc))
