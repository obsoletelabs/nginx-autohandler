"""Let's Encrypt certificates via certbot, using the DNS-01 challenge on Cloudflare.

DNS-01 is the only challenge that can issue wildcard certificates, and it does
not need port 80 reachable from the internet. Certificates live under
/etc/letsencrypt, which compose mounts from ./data/certs.
"""

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import settings

log = logging.getLogger("nginx-autohandler.certs")

CONFIG_DIR = "/etc/letsencrypt"
STATE_DIR = settings.DATA_DIR / "certbot"
CREDENTIALS = STATE_DIR / "cloudflare.ini"
HOST_RE = re.compile(r"^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$")
LINEAGE_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_renew_lock = threading.Lock()
SELFSIGNED_MARKER = "selfsigned.json"


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
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except OSError as exc:
        # certbot ships in the container image; elsewhere it is simply not available.
        return False, f"certbot cannot run on this machine ({exc.strerror or exc}). It is installed in the Docker image."
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


def covers(patterns, name):
    """True when a certificate valid for `patterns` (host names, *.wildcards) is valid for `name`."""
    name = name.strip().lower()
    for pattern in patterns:
        pattern = pattern.strip().lower()
        if pattern == name:
            return True
        if pattern.startswith("*.") and "." in name and name.split(".", 1)[1] == pattern[2:] and not name.startswith("*."):
            return True
    return False


def match(names):
    """Certificates ranked by how many of `names` they cover. Each entry says what it covers and what it misses.

    Best first: all names covered, then valid before expired, then the longest remaining life."""
    names = [name.strip().lower() for name in names if name and name.strip() and name.strip() != "_"]
    ranked = []
    for entry in inventory():
        covered = [name for name in names if covers(entry.get("domains") or [], name)]
        ranked.append({**entry, "covers": covered, "missing": [name for name in names if name not in covered]})
    ranked.sort(key=lambda item: (-len(item["covers"]), not item.get("valid"), -(item.get("days_left") or -9999)))
    return ranked


def cert_name(domains):
    first = domains[0].replace("*.", "wildcard.")
    return first


# ACME certificate authorities: (production directory, staging directory or None, needs EAB keys).
# DNS-01 itself is done by the DNS provider plugin (DNS_PROVIDERS), so any CA that speaks ACME works.
AUTHORITIES = {
    "letsencrypt": ("https://acme-v02.api.letsencrypt.org/directory",
                    "https://acme-staging-v02.api.letsencrypt.org/directory", False),
    "zerossl": ("https://acme.zerossl.com/v2/DV90", None, True),
    "google": ("https://dv.acme-v02.api.pki.goog/directory", "https://dv.acme-v02.test-api.pki.goog/directory", True),
}
AUTHORITY_NAMES = {"letsencrypt": "Let's Encrypt", "zerossl": "ZeroSSL", "google": "Google Trust Services",
                   "custom": "the custom ACME server"}


def authority(staging):
    """(directory URL, extra certbot args) for the configured certificate authority."""
    provider = settings.get("acme_provider")
    if provider == "custom":
        url = settings.get("acme_directory_url").strip()
        if not url.startswith("https://"):
            raise CertError("set the ACME directory URL (https://...) for the custom certificate authority")
        production, test, needs_eab = url, None, bool(settings.get("acme_eab_kid"))
        if staging:
            raise CertError("a custom ACME server has no separate staging service here. Turn staging off to use it.")
    else:
        production, test, needs_eab = AUTHORITIES.get(provider, AUTHORITIES["letsencrypt"])
        if staging and test is None:
            raise CertError(f"{AUTHORITY_NAMES[provider]} has no staging service. Turn staging off to use it.")
    args = ["--server", test if staging else production]
    kid, hmac = settings.get("acme_eab_kid").strip(), settings.get("acme_eab_hmac_key").strip()
    if needs_eab and not (kid and hmac):
        raise CertError(f"{AUTHORITY_NAMES[provider]} needs External Account Binding keys. "
                        "Set the EAB key id and HMAC key in Settings > Certificates.")
    if kid and hmac:
        args += ["--eab-kid", kid, "--eab-hmac-key", hmac]
    return args[1], args


def issue(domains, email, staging, name=None):
    """Issue or expand a certificate for `domains`. Returns (ok, output).

    `name` is the lineage directory under live/. Configs use it to find the files, so
    it can differ from the default derived from the first domain.
    """
    domains = validate_domains(domains)
    if not email:
        raise CertError("set the certificate contact email first")
    _, server_args = authority(staging)
    lineage = name or cert_name(domains)
    if not LINEAGE_RE.match(lineage):
        raise CertError(f"certificate name '{lineage}' may only use letters, digits, dots, dashes and underscores")
    creds = write_credentials()
    args = [
        "certonly", "--agree-tos", "--email", email,
        "--dns-cloudflare", "--dns-cloudflare-credentials", str(creds),
        "--dns-cloudflare-propagation-seconds", "30",
        "--cert-name", lineage,
        "--deploy-hook", "nginx -s reload",
        *server_args,
    ]
    for name in domains:
        args += ["-d", name]
    ok, output = _certbot(args)
    log.info("certbot issue %s: %s", domains, "ok" if ok else "failed")
    return ok, output


# Known certbot failures, most specific first: (text to look for, what to tell the user).
EXPLANATIONS = [
    ("invalid email", "The certificate authority rejected the contact email. Set a real address in Settings > Certificates."),
    ("externalaccountrequired", "This certificate authority needs External Account Binding keys. Set them in Settings > Certificates."),
    ("external account binding", "The certificate authority did not accept the External Account Binding keys. Check them in Settings > Certificates."),
    ("rate limit", "Let's Encrypt's rate limit was hit. Wait before trying again, or keep Staging on while testing."),
    ("too many certificates", "Let's Encrypt's rate limit was hit. Wait before trying again, or keep Staging on while testing."),
    ("error determining zone_id", "Cloudflare did not accept the API token, or it cannot see this domain's zone. "
                                  "It needs Zone:Read and DNS:Edit on the zone."),
    ("invalid request headers", "Cloudflare did not accept the API token. Check it in Settings > Cloudflare."),
    ("authentication error", "Cloudflare did not accept the API token. Check it in Settings > Cloudflare."),
    ("unable to find zone", "The domain is not in a Cloudflare zone this token can see."),
    ("could not find the zone", "The domain is not in a Cloudflare zone this token can see."),
    ("dns problem", "Let's Encrypt could not see the validation record in DNS. Check the domain's nameservers are "
                    "Cloudflare's, then try again."),
    ("no valid ip addresses", "Let's Encrypt could not look up the domain. Check that the zone exists on Cloudflare."),
    ("timed out", "certbot took too long. Check the network connection and try again."),
    ("could not resolve", "The container could not reach the Let's Encrypt or Cloudflare servers. Check its network."),
    ("connection refused", "The container could not reach the Let's Encrypt or Cloudflare servers. Check its network."),
    ("name or service not known", "The container could not reach the Let's Encrypt or Cloudflare servers. Check its network."),
    ("cannot run on this machine", "certbot is not available here. It is installed in the Docker image."),
]


def explain(output):
    """A one-sentence reason for a failed certbot run, or the last line of its output when it is not a known one."""
    lowered = (output or "").lower()
    for needle, message in EXPLANATIONS:
        if needle in lowered:
            return message
    lines = [line.strip() for line in (output or "").splitlines()
             if line.strip() and not line.startswith(("Saving debug log", "Ask for help", "Requesting a"))]
    return lines[-1][:300] if lines else "certbot failed without saying why."


def parse_certificates(output):
    """The text of `certbot certificates` as a list of dicts: name, domains, expires, days_left, staging, valid."""
    found = []
    for block in re.split(r"\n\s*Certificate Name:", "\n" + (output or "")):
        lines = block.strip().splitlines()
        if len(lines) < 2:
            continue
        item = {"name": lines[0].strip(), "domains": [], "expires": "", "days_left": None, "staging": False,
                "valid": False, "path": ""}
        for line in lines[1:]:
            line = line.strip()
            if line.startswith("Domains:"):
                item["domains"] = line.split(":", 1)[1].split()
            elif line.startswith("Expiry Date:"):
                text = line.split(":", 1)[1].strip()
                item["expires"] = text.split(" ")[0]
                item["staging"] = "TEST_CERT" in text
                days = re.search(r"VALID: (\d+) day", text)
                item["days_left"] = int(days.group(1)) if days else (0 if "EXPIRED" in text else None)
                item["valid"] = bool(item["days_left"])
            elif line.startswith("Certificate Path:"):
                item["path"] = line.split(":", 1)[1].strip()
        found.append(item)
    return found


def list_certificates():
    """Raw `certbot certificates` text. Use parse_certificates for a list."""
    _, output = _certbot(["certificates"], timeout=120)
    return output


# ---------------------------------------------------------------- the certificates on disk
#
# Every certificate nginx can use lives in CONFIG_DIR/live/<name>/ as fullchain.pem and
# privkey.pem, whether Let's Encrypt issued it, it was generated here as self-signed, or
# it was uploaded. Listing reads those folders, so all three kinds show up together.

LIVE_DIR = lambda: Path(CONFIG_DIR) / "live"  # noqa: E731
MAX_PEM = 200_000


def _openssl(args, stdin=None, timeout=30):
    """(ok, output) from the openssl command line."""
    try:
        proc = subprocess.run(["openssl", *args], input=stdin, capture_output=True, text=True, timeout=timeout)
    except OSError as exc:
        return False, f"openssl cannot run on this machine ({exc.strerror or exc}). It is installed in the Docker image."
    except subprocess.TimeoutExpired:
        return False, "openssl took too long"
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def _first_pem_certificate(pem):
    match = re.search(r"-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----", pem, re.S)
    return match.group(0) + "\n" if match else None


def describe_certificate(pem):
    """Facts about the first certificate in `pem`: domains, expires, days_left, issuer, subject. None if unreadable."""
    first = _first_pem_certificate(pem)
    if first is None:
        return None
    ok, output = _openssl(["x509", "-noout", "-enddate", "-issuer", "-subject", "-ext", "subjectAltName"], stdin=first)
    if not ok:
        return None
    info = {"domains": [], "issuer": "", "subject": "", "expires": "", "days_left": None}
    for line in output.splitlines():
        line = line.strip()
        if line.startswith("notAfter="):
            try:
                end = datetime.strptime(line.split("=", 1)[1].strip(), "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
                info["expires"] = end.strftime("%Y-%m-%d")
                info["days_left"] = (end - datetime.now(timezone.utc)).days
            except ValueError:
                pass
        elif line.startswith("issuer="):
            info["issuer"] = line.split("=", 1)[1].strip()
        elif line.startswith("subject="):
            info["subject"] = line.split("=", 1)[1].strip()
        elif line.startswith("DNS:"):
            info["domains"] += [part.strip()[4:] for part in line.split(",") if part.strip().startswith("DNS:")]
    if not info["domains"]:
        common = re.search(r"CN\s*=\s*([^,/]+)", info["subject"])
        if common:
            info["domains"] = [common.group(1).strip()]
    return info


def inventory():
    """Every certificate in live/, as dicts the UI can list."""
    found = []
    live = LIVE_DIR()
    if not live.is_dir():
        return found
    for folder in sorted(live.iterdir()):
        full = folder / "fullchain.pem"
        if not folder.is_dir() or not full.is_file():
            continue
        try:
            info = describe_certificate(full.read_text(encoding="utf-8"))
        except OSError:
            info = None
        if info is None:
            continue
        issuer = info["issuer"]
        if (Path(CONFIG_DIR) / "renewal" / f"{folder.name}.conf").exists():
            kind = "letsencrypt" if "let's encrypt" in issuer.lower() or "letsencrypt" in issuer.lower() \
                or "STAGING" in issuer.upper() or "FAKE" in issuer.upper() else "acme"
        elif info["issuer"] and info["issuer"] == info["subject"]:
            kind = "selfsigned"
        else:
            kind = "uploaded"
        staging = kind == "letsencrypt" and ("STAGING" in issuer.upper() or "FAKE" in issuer.upper())
        days = info["days_left"]
        found.append({"name": folder.name, "domains": info["domains"], "expires": info["expires"], "days_left": days,
                      "staging": staging, "valid": days is not None and days > 0, "kind": kind, "issuer": issuer,
                      "path": str(full), "key_path": str(folder / "privkey.pem")})
    return found + external_inventory()


def _lineage_folder(name):
    if not LINEAGE_RE.match(name or ""):
        raise CertError("certificate names may only use letters, digits, dots, dashes and underscores")
    return LIVE_DIR() / name


def _guard_overwrite(folder):
    if (Path(CONFIG_DIR) / "renewal" / f"{folder.name}.conf").exists():
        raise CertError(f"'{folder.name}' is a Let's Encrypt certificate that renews itself. Choose another name.")


def _write_pair(folder, certificate, key):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "fullchain.pem").write_text(certificate, encoding="utf-8", newline="\n")
    (folder / "cert.pem").write_text(_first_pem_certificate(certificate), encoding="utf-8", newline="\n")
    fd = os.open(folder / "privkey.pem", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(key)


def _reload_nginx():
    try:
        subprocess.run(["nginx", "-s", "reload"], capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        pass


def make_selfsigned(domains, name=None, days=365):
    """Generate a self-signed certificate. Returns its inventory entry. The first name entered is the main one."""
    entered = [item.strip().lower() for item in domains if item.strip()]
    domains = sorted(validate_domains(domains), key=entered.index)
    try:
        days = int(days)
    except (TypeError, ValueError):
        raise CertError("days must be a number")
    if not 1 <= days <= 3650:
        raise CertError("days must be between 1 and 3650")
    folder = _lineage_folder(name or cert_name(domains))
    _guard_overwrite(folder)
    with tempfile.TemporaryDirectory() as scratch:
        key_file, cert_file = Path(scratch) / "key.pem", Path(scratch) / "cert.pem"
        ok, output = _openssl([
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", str(days), "-keyout", str(key_file),
            "-out", str(cert_file), "-subj", f"/CN={domains[0]}",
            "-addext", "subjectAltName=" + ",".join(f"DNS:{item}" for item in domains)])
        if not ok:
            raise CertError(f"could not generate the certificate: {output.splitlines()[-1] if output else 'openssl failed'}")
        _write_pair(folder, cert_file.read_text(encoding="utf-8"), key_file.read_text(encoding="utf-8"))
    # Remember how it was made: only certificates this app generated are replaced automatically.
    (folder / SELFSIGNED_MARKER).write_text(json.dumps({"domains": domains, "days": days}), encoding="utf-8")
    log.info("self-signed certificate %s for %s", folder.name, domains)
    _reload_nginx()
    return next(item for item in inventory() if item["name"] == folder.name)


def store_uploaded(name, certificate, key):
    """Check an uploaded certificate and key belong together, then keep them. Returns the inventory entry."""
    certificate, key = (certificate or "").strip() + "\n", (key or "").strip() + "\n"
    if len(certificate) > MAX_PEM or len(key) > MAX_PEM:
        raise CertError("that file is too large to be a certificate")
    info = describe_certificate(certificate)
    if info is None:
        raise CertError("the certificate is not valid PEM text (it should start with -----BEGIN CERTIFICATE-----)")
    if "ENCRYPTED" in key:
        raise CertError("the private key is password protected. Remove the password first (openssl rsa -in key -out plain.key).")
    if "PRIVATE KEY" not in key:
        raise CertError("the private key is not valid PEM text (it should start with -----BEGIN PRIVATE KEY-----)")
    ok_cert, cert_public = _openssl(["x509", "-noout", "-pubkey"], stdin=_first_pem_certificate(certificate))
    ok_key, key_public = _openssl(["pkey", "-pubout"], stdin=key)
    if not ok_key:
        raise CertError("the private key could not be read")
    if not ok_cert or cert_public.strip() != key_public.strip():
        raise CertError("the private key does not belong to this certificate")
    default = cert_name(info["domains"]) if info["domains"] else "uploaded"
    folder = _lineage_folder(name or default)
    _guard_overwrite(folder)
    _write_pair(folder, certificate, key)
    log.info("uploaded certificate %s for %s", folder.name, info["domains"])
    _reload_nginx()
    return next(item for item in inventory() if item["name"] == folder.name)


def delete_certificate(name):
    """Remove a certificate. Let's Encrypt ones are deleted through certbot so they stop renewing."""
    folder = _lineage_folder(name)
    if not folder.is_dir():
        if any(item["name"] == name for item in external_inventory()):
            raise CertError(f"'{name}' comes from a bind-mounted folder, so it is read-only here. Remove it at its source.")
        raise FileNotFoundError(f"no certificate called {name}")
    if (Path(CONFIG_DIR) / "renewal" / f"{name}.conf").exists():
        ok, output = _certbot(["delete", "--cert-name", name], timeout=120)
        if not ok:
            raise CertError(explain(output))
        return
    shutil.rmtree(folder)
    log.info("deleted certificate %s", name)


# ---------------------------------------------------------------- expiry warnings

WARNED_FILE = settings.DATA_DIR / "cert-warnings.json"


def _read_warned():
    try:
        return json.loads(WARNED_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def check_expiry(notify):
    """Tell the notification channels about certificates that expire soon, once per day per certificate."""
    window = settings.get("cert_expiry_warn_days")
    if window <= 0:
        return []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    warned = _read_warned()
    due = []
    for cert in inventory():
        days = cert["days_left"]
        key = cert["path"]
        if days is None or days > window or warned.get(key) == today:
            continue
        warned[key] = today
        state = "has expired" if days <= 0 else f"expires in {days} day{'s' if days != 1 else ''}"
        notify(f"certificate {cert['name']} {state}",
               f"{', '.join(cert['domains'])}: the {cert['kind']} certificate {state} ({cert['expires']}).")
        due.append(cert["name"])
    if due:
        try:
            WARNED_FILE.parent.mkdir(parents=True, exist_ok=True)
            WARNED_FILE.write_text(json.dumps(warned), encoding="utf-8")
        except OSError:
            log.warning("could not remember which certificates were warned about")
    return due


# ---------------------------------------------------------------- certificates from outside (bind mounts)
#
# Folders named in EXTERNAL_CERT_DIRS (default /certs) can hold certificates that something
# else manages: a bind mount from another machine, a Kubernetes-style secret, a cert tool.
# They are listed read-only, nginx can use them from the paths shown, and they get the same
# expiry warnings. Layouts understood:
#   <dir>/<name>/fullchain.pem + privkey.pem   (also tls.crt + tls.key, cert.pem + key.pem ...)
#   <dir>/fullchain.pem + privkey.pem          (a certificate directly in the folder)
#   <dir>/<name>.crt|.pem|.cer + <name>.key    (loose pairs)

CERT_FILES = ("fullchain.pem", "tls.crt", "fullchain.cer", "cert.pem", "certificate.crt", "server.crt", "cert.crt")
KEY_FILES = ("privkey.pem", "tls.key", "key.pem", "private.key", "server.key", "cert.key")


def external_dirs():
    return [Path(item.strip()) for item in settings.get("external_cert_dirs").split(",") if item.strip()]


def _first(folder, names):
    for name in names:
        path = folder / name
        if path.is_file():
            return path
    return None


def _external_pairs(base):
    """(name, certificate path, key path) for every pair under `base`."""
    pairs = []
    cert, key = _first(base, CERT_FILES), _first(base, KEY_FILES)
    if cert and key:
        pairs.append((base.name or "certificate", cert, key))
    try:
        entries = sorted(base.iterdir())
    except OSError:
        return pairs
    for entry in entries:
        if entry.is_dir():
            cert, key = _first(entry, CERT_FILES), _first(entry, KEY_FILES)
            if cert and key:
                pairs.append((entry.name, cert, key))
        elif entry.suffix in (".crt", ".pem", ".cer") and entry.name not in CERT_FILES + KEY_FILES:
            key = entry.with_suffix(".key")
            if key.is_file():
                pairs.append((entry.stem, entry, key))
    return pairs


def external_inventory():
    found = []
    for base in external_dirs():
        if not base.is_dir():
            continue
        for name, cert, key in _external_pairs(base):
            try:
                info = describe_certificate(cert.read_text(encoding="utf-8"))
            except OSError:
                info = None
            if info is None:
                continue
            days = info["days_left"]
            found.append({"name": name, "domains": info["domains"], "expires": info["expires"], "days_left": days,
                          "staging": False, "valid": days is not None and days > 0, "kind": "external",
                          "issuer": info["issuer"], "path": str(cert), "key_path": str(key), "read_only": True})
    return found


def _selfsigned_info(name):
    """(domains, days, generated_here) of a self-signed lineage, or None when `name` is not self-signed."""
    folder = LIVE_DIR() / name
    entry = next((item for item in inventory() if item["name"] == name and item.get("kind") == "selfsigned"), None)
    if entry is None:
        return None
    marker = folder / SELFSIGNED_MARKER
    try:
        saved = json.loads(marker.read_text(encoding="utf-8"))
        return saved["domains"], int(saved["days"]), True
    except (OSError, ValueError, KeyError, TypeError):
        return entry.get("domains", []), 365, False


def reissue(name, staging=None):
    """Make a fresh certificate for `name` now, even though the current one is still valid.

    ACME certificates go through certbot. Self-signed ones are generated again with the same names and lifetime."""
    if not LINEAGE_RE.match(name or ""):
        raise CertError("invalid certificate name")
    if (Path(CONFIG_DIR) / "renewal" / f"{name}.conf").exists():
        if not settings.get("cloudflare_api_token") or not write_credentials().exists():
            raise CertError("set the Cloudflare API token first")
        with _renew_lock:
            ok, output = _certbot(["renew", "--cert-name", name, "--force-renewal", "--deploy-hook", "nginx -s reload"],
                                  timeout=1200)
        log.info("certbot reissue %s: %s", name, "ok" if ok else "failed")
        return ok, output
    info = _selfsigned_info(name)
    if info is None:
        raise CertError(f"'{name}' is an uploaded or bind-mounted certificate, so it cannot be reissued here. "
                        "Upload the new one or replace it at its source.")
    domains, days, _ = info
    try:
        entry = make_selfsigned(domains, name, days)
    except CertError as exc:
        return False, str(exc)
    return True, f"Self-signed certificate {name} generated again, valid until {entry['expires']}."


def renew_due():
    """Renew each certificate that is within CERT_RENEW_DAYS of expiry (or already expired).

    ACME ones are renewed through certbot, self-signed ones this app generated are generated again.
    Uploaded and bind-mounted certificates are never touched. Returns None when there is nothing it can do
    (no DNS credentials and no self-signed certificates), else (ok, output)."""
    limit = max(1, settings.get("cert_renew_days"))
    can_acme = bool(settings.get("cloudflare_api_token")) and CREDENTIALS.exists()
    ok_all, outputs = True, []
    for entry in inventory():
        days_left, name = entry.get("days_left"), entry["name"]
        if days_left is None or entry.get("read_only"):
            continue
        if entry.get("kind") in ("letsencrypt", "acme"):
            if not can_acme or days_left > limit or not (Path(CONFIG_DIR) / "renewal" / f"{name}.conf").exists():
                continue
            with _renew_lock:
                ok, output = _certbot(["renew", "--cert-name", name, "--force-renewal",
                                       "--deploy-hook", "nginx -s reload"], timeout=1200)
        elif entry.get("kind") == "selfsigned":
            info = _selfsigned_info(name)
            if info is None or not info[2] or days_left > min(limit, max(1, info[1] // 3)):
                continue  # not generated here (an uploaded self-signed one), or not due yet
            ok, output = reissue(name)
        else:
            continue
        ok_all = ok_all and ok
        outputs.append(f"{name} ({days_left} days left): {'renewed' if ok else 'FAILED'}\n{output[-800:]}")
    if not outputs and not can_acme:
        return None
    return ok_all, "\n\n".join(outputs)


def renew_loop(notify):
    """Renew every 12 hours (notify only on failure or when something renewed) and warn about expiring certificates."""
    time.sleep(120)  # let the app settle first; the expiry check also runs once at start
    first = True
    while True:
        try:
            if not first:
                result = renew_due()
                if result is not None:
                    ok, output = result
                    if not ok:
                        notify("certificate renewal failed", explain(output) + "\n\n" + output[-1500:])
                    elif output:
                        notify("certificates renewed", output[-1500:])
            first = False
            check_expiry(notify)
        except Exception as exc:  # the loop must survive
            log.exception("renewal check failed")
            notify("certificate renewal check crashed", str(exc))
        time.sleep(12 * 3600)
