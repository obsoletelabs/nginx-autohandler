"""Notifications to Discord and email (SMTP). Both channels fire when both are configured.

Each channel is tried independently, so a failing Discord webhook never blocks the
email, and the other way round. Results are returned, never raised.

Three kinds of message go out:
  send()          a plain note (apply results, tests)
  ip_changed()    the public IP moved and DNS followed (obsoletelabs/cloudflare_updater)
  config_event()  a config change was tested, reloaded, rejected or reverted, with an
                  optional diff (obsoletelabs/nginx-reloading)
"""

import html
import json
import logging
import re
import secrets
import smtplib
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr
from pathlib import Path

import mailtemplate
import settings

log = logging.getLogger("nginx-autohandler.notify")

USER_AGENT = "nginx-autohandler (https://github.com/obsoletelabs)"
LOGO_CID = "autohandler-logo"
LOGO_FILE = Path(__file__).with_name("static") / "logo-dark.png"  # for the dark header of the email
DEFAULT_PORTS = {"ssl": 465, "starttls": 587, "none": 25}
EMBED_DIFF_LIMIT = 3000   # a diff this small goes inside the embed; a larger one is attached
PLAIN_DIFF_LIMIT = 1500   # the same for plain (non-embed) messages
GREEN, RED, YELLOW, GREY = 65280, 16711680, 16776960, 8421504
SUCCESS_OUTCOMES = {"updated", "created", "unchanged", "Successfully updated."}


def fire(function, *args, **kwargs):
    """Run a notification in the background so a slow mail server never holds up a request."""
    def run():
        try:
            function(*args, **kwargs)
        except Exception:  # notifications must never break the thing that triggered them
            log.exception("notification failed")
    threading.Thread(target=run, daemon=True).start()


def service_name():
    return settings.get("service_name") or "nginx-autohandler"


def stamp(moment=None):
    """A timestamp for messages: UTC, local time or both, per the Times setting."""
    moment = time.time() if moment is None else moment
    utc = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(moment)) + " UTC"
    local_struct = time.localtime(moment)
    local = time.strftime("%Y-%m-%d %H:%M:%S %Z", local_struct).strip()
    mode = settings.get("time_display")
    if mode == "utc":
        return utc
    if mode == "local":
        return local
    if time.gmtime(moment)[:5] == local_struct[:5]:
        return utc  # same clock, no need to say it twice
    return f"{utc} ({local})"


def hostname():
    return settings.get("custom_hostname") or socket.gethostname()


# ---------------------------------------------------------------- configuration

def webhook_urls():
    return [url for url in re.split(r"[\s,]+", settings.get("discord_webhook_url")) if url]


def recipients():
    return [address.strip() for address in settings.get("smtp_to").split(",") if address.strip()]


def smtp_ready():
    return bool(settings.get("smtp_enabled") and settings.get("smtp_host") and recipients())


def configured():
    return {"discord": bool(webhook_urls()), "smtp": smtp_ready()}


def _outcome(statuses):
    failed = [status for status in statuses if status != "ok"]
    return "ok" if not failed else failed[0]


# ---------------------------------------------------------------- discord

def _post(url, payload, attachment=None):
    """POST to a webhook. `attachment` is (file name, bytes) and turns the request into multipart."""
    if attachment is None:
        body = json.dumps(payload).encode("utf-8")
        content_type = "application/json"
    else:
        name, content = attachment
        boundary = secrets.token_hex(16)
        body = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\n'
            f"Content-Type: application/json\r\n\r\n{json.dumps(payload)}\r\n"
            f'--{boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="{name}"\r\n'
            f"Content-Type: text/plain\r\n\r\n"
        ).encode("utf-8") + content + f"\r\n--{boundary}--\r\n".encode("utf-8")
        content_type = f"multipart/form-data; boundary={boundary}"
    request = urllib.request.Request(
        url, data=body, method="POST", headers={"Content-Type": content_type, "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read()
        return "ok"
    except (OSError, urllib.error.URLError) as exc:
        log.warning("Discord notification failed: %s", exc)
        return f"error: {exc}"


def _discord_all(payload, attachment=None):
    urls = webhook_urls()
    if not urls:
        return None
    return _outcome([_post(url, payload, attachment) for url in urls])


def _discord_text(content):
    return _discord_all({"username": settings.get("discord_username"), "content": content[:1900]})


# ---------------------------------------------------------------- email

def _from_address():
    return settings.get("smtp_from") or settings.get("smtp_username") or "nginx-autohandler@" + socket.gethostname()


def _open_smtp():
    """Connect to the SMTP server. The certificate is checked against SMTP_TLS_SERVER_NAME when it is set,
    so a server can be reached by IP address (a VPN, a private network) and still be verified."""
    host = settings.get("smtp_host")
    security = settings.get("smtp_security")
    port = settings.get("smtp_port") or DEFAULT_PORTS[security]
    context = ssl.create_default_context()
    if not settings.get("smtp_verify_tls"):
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    server = smtplib.SMTP_SSL(timeout=20, context=context) if security == "ssl" else smtplib.SMTP(timeout=20)
    server._host = settings.get("smtp_tls_server_name") or host  # the name TLS is checked against
    server.connect(host, port)
    if security == "starttls":
        server.starttls(context=context)
    return server


def _mail(subject, plain, html_body, to=None):
    """Send one multipart message with retries. Returns "ok" or an error text."""
    to = to or recipients()
    sender = _from_address()
    address = parseaddr(sender)[1] or sender
    message = EmailMessage()
    message["From"] = sender
    message["To"] = ", ".join(to)
    message["Subject"] = subject
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()
    message["Reply-To"] = settings.get("smtp_reply_to") or sender
    message["List-Unsubscribe"] = settings.get("smtp_unsubscribe") or f"<mailto:{address}>"
    message["Precedence"] = settings.get("smtp_precedence")
    message.set_content(plain)
    message.add_alternative(html_body, subtype="html")
    logo = _logo()
    if logo and "cid:" + LOGO_CID in html_body:
        message.get_payload()[1].add_related(logo, "image", "png", cid=f"<{LOGO_CID}>", disposition="inline")

    attempts = max(1, settings.get("smtp_retries"))
    try:
        delay = float(settings.get("smtp_retry_delay"))
    except ValueError:
        delay = 1.5
    last = "unknown error"
    for attempt in range(1, attempts + 1):
        try:
            server = _open_smtp()
            try:
                if settings.get("smtp_username"):
                    server.login(settings.get("smtp_username"), settings.get("smtp_password"))
                server.send_message(message, from_addr=address, to_addrs=to)
            finally:
                try:
                    server.quit()
                except (OSError, smtplib.SMTPException):
                    pass
            return "ok"
        except (OSError, smtplib.SMTPException) as exc:
            last = str(exc)
            log.warning("SMTP attempt %d/%d failed: %s", attempt, attempts, exc)
            if attempt < attempts:
                time.sleep(delay)
    return f"error: {last}"


def _logo():
    try:
        return LOGO_FILE.read_bytes()
    except OSError:
        return None


def email(context, to=None):
    """Send a templated email (see mailtemplate for the context keys). Returns "ok", an error text, or None
    when email is not set up."""
    if not smtp_ready():
        return None
    html_body, plain = mailtemplate.render(context, service_name(), hostname(), LOGO_CID if _logo() else None)
    return _mail(context.get("Subject") or context.get("Title") or "Message", plain, html_body, to)


# ---------------------------------------------------------------- plain notes

def _status_for(text):
    lowered = text.lower()
    if any(word in lowered for word in ("failed", "expired", "rejected", "error", "crashed", "could not")):
        return "bad"
    if any(word in lowered for word in ("expires", "warning", "attention", "refused", "not confirmed")):
        return "warn"
    if any(word in lowered for word in ("issued", "renewed", "applied", "success", "saved", "ok")):
        return "good"
    return "info"


def send(subject, text):
    """A plain note on every configured channel. Returns {channel: "ok" | error text}."""
    results = {}
    discord = _discord_text(f"**{subject}**\n{text}")
    if discord is not None:
        results["discord"] = discord
    if smtp_ready():
        results["smtp"] = email({"Subject": f"[{service_name()}] {subject}", "Title": subject[:1].upper() + subject[1:],
                                 "Status": _status_for(subject), "Lead": text})
    return results


# ---------------------------------------------------------------- IP changes

def ip_changed(old_ip, new_ip, source, results):
    """Announce a public IP change and what DNS did about it."""
    sent = {}
    text = f"WARNING ip {old_ip} CHANGED to {new_ip}!"
    if settings.get("discord_bold"):
        text = f"**{text}**"
    level = max(0, min(3, settings.get("discord_prefix_header")))
    if level:
        text = f"{'#' * level} {text}"
    text += settings.get("discord_ping")
    discord = _discord_text(text)
    if discord is not None:
        sent["discord"] = discord

    shown = [(name, outcome) for name, outcome in sorted(results.items()) if outcome != "unchanged"]
    failed = [item for item in shown if str(item[1]).startswith("error")]
    context = {
        "Subject": f"IP Address Change Detected for {service_name()}",
        "Title": "Your public IP address changed",
        "Status": "warn" if failed else "good",
        "Lead": ("The address this host answers to changed, and DNS was brought in line."
                 + (f" {len(failed)} record(s) could not be updated and need a look." if failed else "")),
        "Facts": [("Old address", old_ip), ("New address", new_ip), ("Reported by", source),
                  ("Host", hostname()), ("Time", stamp())],
        "Rows": shown,
        "Preheader": f"{old_ip} is now {new_ip}",
    }
    if not shown:
        context["Lead"] += " No DNS records needed changing."
    sent_mail = email(context)
    if sent_mail is not None:
        sent["smtp"] = sent_mail
    return sent


# ---------------------------------------------------------------- config changes

def config_event(title, message, color, detail="", diff=""):
    """Report a config change. `detail` is raw output (a failed test), `diff` is unified-diff text."""
    sent = {}
    host = hostname()
    use_embeds = settings.get("use_embeds")
    diff_bytes = diff.encode("utf-8")
    attachment = None

    description = message
    if detail:
        description += f"\n```\n{detail[:2500]}\n```"
    if diff:
        limit = EMBED_DIFF_LIMIT if use_embeds else PLAIN_DIFF_LIMIT
        if len(diff_bytes) < limit:
            description += f"\n\n**File Changes:**\n```diff\n{diff}\n```"
        else:
            attachment = ("nginx-changes.diff", diff_bytes)

    if use_embeds:
        embed = {"title": title, "description": description[:4000], "color": color}
        if settings.get("include_hostname"):
            embed["fields"] = [{"name": "Hostname", "value": host}]
        discord = _discord_all({"username": settings.get("discord_username"), "embeds": [embed]}, attachment)
    else:
        discord = _discord_all({"username": settings.get("discord_username"),
                                "content": f"{title}: {description}"[:1900]}, attachment)
    if discord is not None:
        sent["discord"] = discord

    if smtp_ready():
        status = {GREEN: "good", RED: "bad", YELLOW: "warn"}.get(color, "info")
        files = [line for line in message.splitlines() if line.startswith("Files:")]
        lead = "\n".join(line for line in message.splitlines() if not line.startswith("Files:")).strip()
        context = {"Subject": f"[{service_name()}] {title}", "Title": title.lstrip("✅❌⚠️ℹ️ ").strip() or title,
                   "Status": status, "Lead": lead,
                   "Facts": ([("Files", files[0][len("Files:"):].strip())] if files else [])
                   + ([("Host", host)] if settings.get("include_hostname") else [])
                   + [("Time", stamp())]}
        if detail:
            context["Pre"] = detail
            context["PreLabel"] = "nginx output"
        if diff:
            context["Diff"] = diff
        sent["smtp"] = email(context)
    return sent
