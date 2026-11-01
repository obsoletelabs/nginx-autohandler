"""Runtime settings and secrets.

Each setting has an environment variable. A non-empty environment value always
wins and locks the setting in the UI. Otherwise a value saved from the UI is used,
then the default. Secrets are write-only: the UI can set or clear them and can
only show whether they are set.

UI values live in DATA_DIR/settings.json, which is written with mode 0600.
"""

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path

DATA_DIR = Path(os.environ.get("NGINX_AUTOHANDLER_DATA", "/var/lib/nginx-autohandler"))
SETTINGS_FILE = DATA_DIR / "settings.json"
_lock = threading.Lock()


class SettingError(ValueError):
    pass


@dataclass(frozen=True)
class Spec:
    key: str
    env: str
    kind: str  # "text" | "secret" | "bool" | "int" | "choice"
    default: str
    label: str
    group: str
    choices: tuple = ()


SPECS = [
    Spec("cloudflare_api_token", "CLOUDFLARE_API_TOKEN", "secret", "", "API token", "Cloudflare"),
    Spec("cloudflare_proxied", "CLOUDFLARE_PROXIED", "bool", "false", "Proxy new records (orange cloud)", "Cloudflare"),
    Spec("cloudflare_ip_sync", "CLOUDFLARE_IP_SYNC", "bool", "true", "Keep records on this host's public IP", "Cloudflare"),
    Spec("cloudflare_dns_from_configs", "CLOUDFLARE_DNS_FROM_CONFIGS", "bool", "true",
         "Create A records for server_name on save", "Cloudflare"),
    Spec("cloudflare_check_interval_seconds", "CLOUDFLARE_CHECK_INTERVAL_SECONDS", "int", "600",
         "IP sync interval (seconds)", "Cloudflare"),
    Spec("acme_email", "ACME_EMAIL", "text", "", "Let's Encrypt contact email", "Certificates"),
    Spec("acme_staging", "ACME_STAGING", "bool", "true", "Use Let's Encrypt staging", "Certificates"),
    Spec("smtp_host", "SMTP_HOST", "text", "", "Host", "Email (SMTP)"),
    Spec("smtp_port", "SMTP_PORT", "int", "587", "Port", "Email (SMTP)"),
    Spec("smtp_security", "SMTP_SECURITY", "choice", "starttls", "Security", "Email (SMTP)",
         ("none", "starttls", "ssl")),
    Spec("smtp_username", "SMTP_USERNAME", "text", "", "Username", "Email (SMTP)"),
    Spec("smtp_password", "SMTP_PASSWORD", "secret", "", "Password", "Email (SMTP)"),
    Spec("smtp_from", "SMTP_FROM", "text", "", "From address", "Email (SMTP)"),
    Spec("smtp_to", "SMTP_TO", "text", "", "Recipients (comma separated)", "Email (SMTP)"),
    Spec("discord_webhook_url", "DISCORD_WEBHOOK_URL", "secret", "", "Webhook URL", "Discord"),
    Spec("auto_reload", "NGINX_AUTO_RELOAD", "bool", "true", "Reload nginx after a valid save", "Nginx"),
    Spec("backup_keep", "NGINX_AUTOHANDLER_BACKUP_KEEP", "int", "4", "Backups kept per file", "Nginx"),
]
BY_KEY = {spec.key: spec for spec in SPECS}


def _load():
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(data):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_name(SETTINGS_FILE.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, SETTINGS_FILE)


def _coerce(spec, raw):
    """Turn a stored or environment string into the spec's Python value."""
    if spec.kind == "bool":
        return str(raw).strip().lower() in ("1", "true", "yes", "on")
    if spec.kind == "int":
        return int(raw)
    return str(raw)


def source(spec):
    """Where the effective value comes from: env, ui or default."""
    if os.environ.get(spec.env, "").strip():
        return "env"
    with _lock:
        if spec.key in _load():
            return "ui"
    return "default"


def get(key):
    spec = BY_KEY[key]
    env_value = os.environ.get(spec.env, "").strip()
    if env_value:
        return _coerce(spec, env_value)
    with _lock:
        stored = _load().get(key)
    if stored is not None and stored != "":
        return _coerce(spec, stored)
    return _coerce(spec, spec.default)


def describe():
    """Settings for the UI. Secrets report only whether they are set."""
    out = []
    for spec in SPECS:
        src = source(spec)
        item = {
            "key": spec.key, "label": spec.label, "group": spec.group, "kind": spec.kind,
            "choices": list(spec.choices), "source": src, "locked": src == "env", "env": spec.env,
        }
        if spec.kind == "secret":
            item["is_set"] = bool(get(spec.key))
        else:
            item["value"] = get(spec.key)
        out.append(item)
    return out


def update(values):
    """Save UI values. An empty string clears a UI value. Env-locked keys are refused."""
    if not isinstance(values, dict):
        raise SettingError("expected an object of key/value pairs")
    with _lock:
        data = _load()
        for key, raw in values.items():
            spec = BY_KEY.get(key)
            if spec is None:
                raise SettingError(f"unknown setting: {key}")
            if os.environ.get(spec.env, "").strip():
                raise SettingError(f"{spec.label} is set by the {spec.env} environment variable")
            if raw is None or raw == "":
                data.pop(key, None)
                continue
            if spec.kind == "bool":
                if not isinstance(raw, bool):
                    raise SettingError(f"{spec.label} must be true or false")
                data[key] = raw
            elif spec.kind == "int":
                try:
                    data[key] = int(raw)
                except (TypeError, ValueError):
                    raise SettingError(f"{spec.label} must be a whole number") from None
            elif spec.kind == "choice":
                if raw not in spec.choices:
                    raise SettingError(f"{spec.label} must be one of {', '.join(spec.choices)}")
                data[key] = raw
            else:
                if not isinstance(raw, str):
                    raise SettingError(f"{spec.label} must be text")
                data[key] = raw.strip()
        _save(data)
