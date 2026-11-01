"""Runtime settings and secrets.

Each setting has an environment variable. A non-empty environment value always
wins and locks the setting in the UI. Otherwise a value saved from the UI is used,
then the default. Secrets are write-only: the UI can set or clear them and can
only show whether they are set.

Most settings also accept the names used by the projects this one grew out of
(obsoletelabs/cloudflare_updater and obsoletelabs/nginx-reloading), so an existing
environment block keeps working. Those are listed as `aliases`.

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
    aliases: tuple = ()  # other environment names that set the same value


SPECS = [
    # Cloudflare: DNS records and the IP updater
    Spec("cloudflare_api_token", "CLOUDFLARE_API_TOKEN", "secret", "", "API token", "Cloudflare"),
    Spec("cloudflare_proxied", "CLOUDFLARE_PROXIED", "bool", "false", "Proxy new records (orange cloud)", "Cloudflare"),
    Spec("cloudflare_ip_sync", "CLOUDFLARE_IP_SYNC", "bool", "true", "Keep records on this host's public IP", "Cloudflare"),
    Spec("cloudflare_move_old_ip_records", "CLOUDFLARE_MOVE_OLD_IP_RECORDS", "bool", "true",
         "When the IP changes, move every A record that pointed at the old IP", "Cloudflare"),
    Spec("cloudflare_dns_from_configs", "CLOUDFLARE_DNS_FROM_CONFIGS", "bool", "true",
         "Create A records for server_name on save", "Cloudflare"),
    Spec("cloudflare_check_interval_seconds", "CLOUDFLARE_CHECK_INTERVAL_SECONDS", "int", "600",
         "IP check interval (seconds)", "Cloudflare", aliases=("CHECK_INTERVAL_SECONDS",)),
    Spec("retry_interval_seconds", "RETRY_INTERVAL_SECONDS", "int", "10",
         "Retry delay when no whoami URL answers (seconds)", "Cloudflare"),

    # Whoami: how this host finds its public IP
    Spec("whoami_urls", "WHOAMI_URLS", "text", "",
         "Whoami URLs, comma separated, tried in order", "Public IP lookup"),
    Spec("override_obsolete_whoami", "OVERRIDE_OBSOLETE_WHOAMI", "bool", "false",
         "Do not add the obsoletelabs whoami servers as fallbacks", "Public IP lookup"),
    Spec("enforce_dns_resolution", "ENFORCE_DNS_RESOLUTION", "bool", "false",
         "Drop whoami URLs whose host does not resolve", "Public IP lookup"),
    Spec("test_url_connectivity", "TEST_URL_CONNECTIVITY", "bool", "true",
         "Test each whoami URL at startup", "Public IP lookup"),
    Spec("enforce_url_connectivity", "ENFORCE_URL_CONNECTIVITY", "bool", "false",
         "Drop whoami URLs that cannot be reached", "Public IP lookup"),
    Spec("enforce_url_validity", "ENFORCE_URL_VALIDITY", "bool", "false",
         "Drop whoami URLs that do not answer with an IP", "Public IP lookup"),
    Spec("ip_change_confirm_seconds", "IP_CHANGE_CONFIRM_SECONDS", "int", "5",
         "Wait this long and ask again before acting on a changed IP (0 acts at once)", "Public IP lookup"),
    Spec("initial_ip", "INITIAL_IP", "text", "",
         "Starting IP for testing (skips detecting it on first run)", "Public IP lookup"),

    # Certificates
    Spec("acme_email", "ACME_EMAIL", "text", "", "Let's Encrypt contact email", "Certificates"),
    Spec("acme_provider", "ACME_PROVIDER", "choice", "letsencrypt", "Certificate authority (ACME)", "Certificates",
         choices=("letsencrypt", "zerossl", "google", "custom")),
    Spec("acme_directory_url", "ACME_DIRECTORY_URL", "text", "", "Custom ACME directory URL (when the authority is custom)",
         "Certificates"),
    Spec("acme_eab_kid", "ACME_EAB_KID", "text", "", "External account binding key id (ZeroSSL, Google)", "Certificates"),
    Spec("acme_eab_hmac_key", "ACME_EAB_HMAC_KEY", "secret", "", "External account binding HMAC key", "Certificates"),
    Spec("acme_dns_provider", "ACME_DNS_PROVIDER", "choice", "cloudflare", "DNS provider for the DNS-01 challenge",
         "Certificates", choices=("cloudflare",)),
    Spec("acme_staging", "ACME_STAGING", "bool", "true", "Use the staging service (test certificates)", "Certificates"),
    Spec("external_cert_dirs", "EXTERNAL_CERT_DIRS", "text", "/certs",
         "Folders of certificates you bind-mount, comma separated (listed read-only)", "Certificates"),
    Spec("cert_renew_days", "CERT_RENEW_DAYS", "int", "30",
         "Renew Let's Encrypt/ACME certificates this many days before they expire (checked every 12 hours)", "Certificates"),
    Spec("cert_expiry_warn_days", "CERT_EXPIRY_WARN_DAYS", "int", "14",
         "Warn this many days before a certificate expires (0 turns warnings off)", "Certificates"),

    # Git sync
    Spec("git_repo_url", "GIT_REPO_URL", "text", "",
         "Repository URL (https://github.com/you/nginx-config.git). Leave empty to turn git sync off", "Git sync"),
    Spec("git_branch", "GIT_BRANCH", "text", "main", "Branch", "Git sync"),
    Spec("git_subdir", "GIT_SUBDIR", "text", "", "Folder inside the repository that holds the nginx config (empty = the top)",
         "Git sync"),
    Spec("git_token", "GIT_TOKEN", "secret", "", "Access token (a GitHub token with Contents access to the repository)",
         "Git sync"),
    Spec("git_mode", "GIT_MODE", "choice", "pull", "What to sync", "Git sync", ("pull", "push", "both")),
    Spec("git_interval_minutes", "GIT_INTERVAL_MINUTES", "int", "0",
         "Sync automatically every this many minutes (0 = only when you press the button)", "Git sync"),
    Spec("git_conflicts", "GIT_CONFLICTS", "choice", "keep-local",
         "When a file changed both here and in the repository", "Git sync", ("keep-local", "use-repo")),
    Spec("git_author_name", "GIT_AUTHOR_NAME", "text", "", "Name on commits made here (default: nginx-autohandler)", "Git sync"),
    Spec("git_author_email", "GIT_AUTHOR_EMAIL", "text", "", "Email on commits made here", "Git sync"),

    # Email
    Spec("smtp_enabled", "SMTP_ENABLED", "bool", "true", "Send email notifications", "Email (SMTP)",
         aliases=("NOTIFIER_SMTP_ENABLED",)),
    Spec("smtp_host", "SMTP_HOST", "text", "", "Host", "Email (SMTP)", aliases=("NOTIFIER_SMTP_SERVER",)),
    Spec("smtp_security", "SMTP_SECURITY", "choice", "starttls", "Security", "Email (SMTP)",
         ("none", "starttls", "ssl"), aliases=("NOTIFIER_SMTP_SECURITY",)),
    Spec("smtp_tls_server_name", "SMTP_TLS_SERVER_NAME", "text", "",
         "Name in the server certificate (set it when the host above is an IP address)", "Email (SMTP)"),
    Spec("smtp_verify_tls", "SMTP_VERIFY_TLS", "bool", "true", "Check the server certificate", "Email (SMTP)"),
    Spec("smtp_port", "SMTP_PORT", "int", "0", "Port (0 uses the default for the security mode)", "Email (SMTP)",
         aliases=("NOTIFIER_SMTP_PORT",)),
    Spec("smtp_username", "SMTP_USERNAME", "text", "", "Username", "Email (SMTP)", aliases=("NOTIFIER_SMTP_USERNAME",)),
    Spec("smtp_password", "SMTP_PASSWORD", "secret", "", "Password", "Email (SMTP)", aliases=("NOTIFIER_SMTP_PASSWORD",)),
    Spec("smtp_from", "SMTP_FROM", "text", "", "From address", "Email (SMTP)", aliases=("NOTIFIER_EMAIL_FROM_ADDRESS",)),
    Spec("smtp_to", "SMTP_TO", "text", "", "Recipients (comma separated)", "Email (SMTP)",
         aliases=("NOTIFIER_EMAIL_TO_ADDRESSES",)),
    Spec("smtp_reply_to", "SMTP_REPLY_TO", "text", "", "Reply-To address", "Email (SMTP)",
         aliases=("NOTIFIER_SMTP_REPLYTO_ADDRESS", "NOTIIFER_SMTP_REPLYTO_ADDRESS")),
    Spec("smtp_unsubscribe", "SMTP_UNSUBSCRIBE", "text", "", "List-Unsubscribe header", "Email (SMTP)",
         aliases=("NOTIFIER_SMTP_UNSUBSCRIBE_HEADER",)),
    Spec("smtp_precedence", "SMTP_PRECEDENCE", "choice", "bulk", "Precedence header", "Email (SMTP)",
         ("bulk", "list", "junk", "auto_reply"), aliases=("NOTIFIER_SMTP_PRECEDENCE",)),
    Spec("smtp_retries", "SMTP_RETRIES", "int", "3", "Send attempts", "Email (SMTP)",
         aliases=("NOTIFIER_SMTP_RETRIES",)),
    Spec("smtp_retry_delay", "SMTP_RETRY_DELAY", "text", "1.5", "Seconds between attempts", "Email (SMTP)",
         aliases=("NOTIFIER_SMTP_RETRY_DELAY",)),

    # Discord
    Spec("discord_webhook_url", "DISCORD_WEBHOOK_URL", "secret", "",
         "Webhook URL (several allowed, comma separated)", "Discord"),
    Spec("discord_username", "DISCORD_USERNAME", "text", "nginx autohandler", "Name shown on messages", "Discord"),
    Spec("discord_ping", "DISCORD_PING", "text", "", "Ping appended to IP change messages (for example @here)", "Discord"),
    Spec("discord_bold", "DISCORD_BOLD", "bool", "false", "Bold IP change messages", "Discord"),
    Spec("discord_prefix_header", "DISCORD_PREFIX_HEADER", "int", "0",
         "Heading level for IP change messages (0 to 3)", "Discord"),
    Spec("use_embeds", "USE_EMBEDS", "bool", "true", "Send config changes as embeds", "Discord"),

    # Nginx: reloading and change reports
    Spec("auto_reload", "NGINX_AUTO_RELOAD", "bool", "true", "Reload nginx after a valid change", "Nginx"),
    Spec("watch_config", "WATCH_CONFIG", "bool", "true",
         "Watch the config folder for edits made outside this page", "Nginx"),
    Spec("send_diff", "SEND_DIFF", "bool", "true", "Include a diff in change reports", "Nginx"),
    Spec("diff_context", "DIFF_CONTEXT", "int", "3", "Lines of context around each change", "Nginx"),
    Spec("include_hostname", "INCLUDE_HOSTNAME", "bool", "true", "Name this host in change reports", "Nginx"),
    Spec("custom_hostname", "CUSTOM_HOSTNAME", "text", "", "Host name to show instead of the machine's", "Nginx"),
    Spec("backup_keep", "NGINX_AUTOHANDLER_BACKUP_KEEP", "int", "4", "Backups kept per file", "Nginx"),

    # General
    Spec("service_name", "SERVICE_NAME", "text", "Obsoletelabs Nginx Autohandler",
         "Name used in emails and messages", "General"),
    Spec("disable_welcome_email", "DISABLE_WELCOME_EMAIL", "bool", "false", "No welcome email on first start", "General"),
    Spec("disable_restart_email", "DISABLE_RESTART_EMAIL", "bool", "false", "No email when the service restarts", "General"),
    Spec("time_display", "TIME_DISPLAY", "choice", "both",
         "Times in emails and notices (local uses the container's TZ setting)", "General", ("both", "utc", "local")),
    Spec("log_level", "LOG_LEVEL", "choice", "info", "Log level (applies at start)", "General",
         ("debug", "info", "warning", "error", "critical")),
    Spec("max_log_bytes", "MAX_LOG_BYTES", "int", "50000000", "Log file size before it is rotated", "General"),
    Spec("enable_colored_logging", "ENABLE_COLORED_LOGGING", "bool", "true", "Colour the console log", "General"),
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
        try:
            return int(raw)
        except (TypeError, ValueError):
            return int(spec.default)
    if spec.kind == "choice":
        value = str(raw).strip().lower()
        if spec.key == "smtp_security" and value == "tls":
            value = "ssl"  # cloudflare_updater calls implicit TLS "tls"
        return value if value in spec.choices else spec.default
    return str(raw)


def _env(spec):
    """(name, value) of the first environment variable that is set and not empty, else (None, "")."""
    for name in (spec.env, *spec.aliases):
        value = os.environ.get(name, "").strip()
        if value:
            return name, value
    return None, ""


def source(spec):
    """Where the effective value comes from: env, ui or default."""
    if _env(spec)[0]:
        return "env"
    with _lock:
        if spec.key in _load():
            return "ui"
    return "default"


def get(key):
    spec = BY_KEY[key]
    _, env_value = _env(spec)
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
            "choices": list(spec.choices), "source": src, "locked": src == "env", "env": _env(spec)[0] or spec.env,
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
            env_name, _ = _env(spec)
            if env_name:
                raise SettingError(f"{spec.label} is set by the {env_name} environment variable")
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
