"""Notifications to Discord and email (SMTP). Both channels fire when both are configured.

Each channel is tried independently, so a failing Discord webhook never blocks
the email, and the other way round. Results are returned, never raised.
"""

import json
import logging
import smtplib
import socket
import ssl
import urllib.request
from email.message import EmailMessage

import settings

log = logging.getLogger("nginx-autohandler.notify")


def send(subject, text):
    """Send to every configured channel. Returns {channel: "ok" | error text}."""
    results = {}
    if settings.get("discord_webhook_url"):
        results["discord"] = _discord(f"**{subject}**\n{text}")
    if settings.get("smtp_host") and settings.get("smtp_to"):
        results["smtp"] = _smtp(subject, text)
    return results


def configured():
    return {
        "discord": bool(settings.get("discord_webhook_url")),
        "smtp": bool(settings.get("smtp_host") and settings.get("smtp_to")),
    }


def _discord(content):
    url = settings.get("discord_webhook_url")
    body = json.dumps({"content": content[:1900]}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        return "ok"
    except OSError as exc:
        log.warning("Discord notification failed: %s", exc)
        return f"error: {exc}"


def _smtp(subject, text):
    host = settings.get("smtp_host")
    port = settings.get("smtp_port")
    security = settings.get("smtp_security")
    username = settings.get("smtp_username")
    password = settings.get("smtp_password")
    recipients = [a.strip() for a in settings.get("smtp_to").split(",") if a.strip()]
    sender = settings.get("smtp_from") or username or "nginx-autohandler@" + socket.gethostname()

    msg = EmailMessage()
    msg["Subject"] = f"[nginx-autohandler] {subject}"
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg.set_content(text)

    context = ssl.create_default_context()
    try:
        if security == "ssl":
            server = smtplib.SMTP_SSL(host, port, context=context, timeout=20)
        else:
            server = smtplib.SMTP(host, port, timeout=20)
        try:
            if security == "starttls":
                server.starttls(context=context)
            if username:
                server.login(username, password)
            server.send_message(msg, to_addrs=recipients)
        finally:
            server.quit()
        return "ok"
    except (OSError, smtplib.SMTPException) as exc:
        log.warning("SMTP notification failed: %s", exc)
        return f"error: {exc}"
