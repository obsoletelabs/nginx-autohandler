"""The HTML and plain-text bodies of the emails this app sends.

One layout for every message: a dark header with the logo, a coloured status pill and headline,
a short lead paragraph, then any of: key/value facts, a list of results (domain: outcome), startup
notes, preformatted output and a colour-coded diff. It is built from nested tables with inline
styles only (no web fonts, no remote images, no scripts), which is what mail clients render
reliably. The plain-text part carries the same content.

Context keys (all optional except Title):
  Title      headline                          Status   good | warn | bad | info
  Lead       short paragraph (plain text)      Preheader  the grey preview line in the inbox
  Facts      [(label, value), ...]             Rows     [(name, outcome), ...] shown with status pills
  Notes      ["INFO: ...", ...]                Pre      preformatted output (a failed config test)
  Diff       unified diff text                 Footer   small print
  Body       raw HTML, for callers that already have markup (kept for compatibility)
"""

import html

ACCENT = {
    "good": ("#1f8a4c", "#e7f5ec", "Success"),
    "warn": ("#b86e00", "#fdf2dc", "Attention"),
    "bad": ("#c93c3c", "#fdeaea", "Problem"),
    "info": ("#2f62c4", "#e8effb", "Notice"),
}
BRAND = "#ea6a3a"
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
MONO = "SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace"
GOOD_OUTCOMES = {"updated", "created", "unchanged", "Successfully updated."}


def _e(value):
    return html.escape(str(value), quote=True)


def _paragraphs(text):
    """Plain text to <p> blocks: blank lines separate paragraphs, single newlines become <br>."""
    blocks = [block for block in str(text).replace("\r\n", "\n").split("\n\n") if block.strip()]
    return "".join(
        f'<p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;color:#2a3140;">{_e(block).replace(chr(10), "<br>")}</p>'
        for block in blocks)


def _facts(rows):
    cells = "".join(
        f'<tr><td style="padding:7px 12px 7px 0;font-size:13px;color:#6b7385;white-space:nowrap;vertical-align:top;">{_e(label)}</td>'
        f'<td style="padding:7px 0;font-size:14px;color:#1d2330;font-family:{MONO};word-break:break-all;">{_e(value)}</td></tr>'
        for label, value in rows)
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px 0;'
            f'border-top:1px solid #e6e9ef;border-bottom:1px solid #e6e9ef;">{cells}</table>')


def _pill(outcome):
    text = str(outcome)
    if text.startswith("error"):
        colour, tint = ACCENT["bad"][:2]
        label = "Error"
    elif text in GOOD_OUTCOMES:
        colour, tint = ACCENT["good"][:2]
        label = "Unchanged" if text == "unchanged" else "Updated" if text.startswith("Success") else text.capitalize()
    else:
        colour, tint = ACCENT["info"][:2]
        label = text[:40]
    return (f'<span style="display:inline-block;padding:2px 9px;border-radius:10px;background:{tint};color:{colour};'
            f'font-size:12px;font-weight:600;">{_e(label)}</span>')


def _rows(rows):
    cells = []
    for name, outcome in rows:
        detail = ""
        if str(outcome).startswith("error"):
            detail = (f'<div style="font-size:12px;color:#c93c3c;margin-top:3px;word-break:break-word;">'
                      f'{_e(str(outcome)[6:].strip())}</div>')
        cells.append(
            f'<tr><td style="padding:9px 0;border-bottom:1px solid #eef0f4;font-size:14px;color:#1d2330;'
            f'font-family:{MONO};word-break:break-all;">{_e(name)}{detail}</td>'
            f'<td align="right" style="padding:9px 0 9px 12px;border-bottom:1px solid #eef0f4;white-space:nowrap;'
            f'vertical-align:top;">{_pill(outcome)}</td></tr>')
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0;">'
            f'{"".join(cells)}</table>')


def _notes(lines):
    out = []
    for line in lines:
        text = str(line)
        colour = "#b86e00" if text.startswith("WARNING") else "#c93c3c" if text.startswith("ERROR") else "#4a5367"
        out.append(f'<div style="padding:3px 0;font-size:13px;line-height:1.5;color:{colour};">{_e(text)}</div>')
    return (f'<div style="margin:0 0 18px 0;padding:12px 14px;background:#f5f6f9;border-radius:8px;">'
            f'{"".join(out)}</div>')


def _pre(text, label=None):
    heading = (f'<div style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7385;'
               f'margin:0 0 6px 0;">{_e(label)}</div>') if label else ""
    return (f'{heading}<pre style="margin:0 0 18px 0;padding:12px 14px;background:#14181f;color:#d9dee8;border-radius:8px;'
            f'font-family:{MONO};font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;'
            f'overflow-x:auto;">{_e(text)}</pre>')


def _diff(text):
    lines = []
    for line in text.splitlines():
        if line.startswith(("+++", "---")):
            style = "color:#9aa3b5;"
        elif line.startswith("@@"):
            style = "color:#7fb0ff;"
        elif line.startswith("+"):
            style = "color:#7ee0a0;background:#16291f;"
        elif line.startswith("-"):
            style = "color:#ff9c9c;background:#331b1d;"
        else:
            style = "color:#c8cedb;"
        lines.append(f'<div style="{style}white-space:pre-wrap;word-break:break-word;">{_e(line) or "&nbsp;"}</div>')
    return (f'<div style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7385;'
            f'margin:0 0 6px 0;">File changes</div>'
            f'<div style="margin:0 0 18px 0;padding:12px 14px;background:#14181f;border-radius:8px;font-family:{MONO};'
            f'font-size:12.5px;line-height:1.5;">{"".join(lines)}</div>')


def render(context, service, host="", logo_cid=None):
    """(html, plain) for one message. `service` is the service name shown in the header."""
    status = context.get("Status", "info")
    colour, tint, word = ACCENT.get(status, ACCENT["info"])
    title = context.get("Title") or context.get("Subject", "Message")
    footer = context.get("Footer") or f"Automated message from {service}" + (f" on {host}" if host else "") + "."
    preheader = context.get("Preheader") or context.get("Lead", "")[:120]

    body = ""
    if context.get("Lead"):
        body += _paragraphs(context["Lead"])
    if context.get("Facts"):
        body += _facts(context["Facts"])
    if context.get("Rows"):
        body += _rows(context["Rows"])
    if context.get("Notes"):
        body += _notes(context["Notes"])
    if context.get("Pre"):
        body += _pre(context["Pre"], context.get("PreLabel", "Output"))
    if context.get("Diff"):
        body += _diff(context["Diff"])
    if context.get("Body"):
        body += f'<div style="font-size:15px;line-height:1.55;color:#2a3140;">{context["Body"]}</div>'

    logo = (f'<img src="cid:{logo_cid}" width="32" height="32" alt="" style="display:block;border:0;">'
            if logo_cid else "")
    html_text = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>{_e(title)}</title></head>
<body style="margin:0;padding:0;background:#eceef3;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{_e(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eceef3;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:{FONT};">
<tr><td style="background:#14181f;border-radius:12px 12px 0 0;border-bottom:3px solid {BRAND};padding:16px 22px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">{logo}</td>
<td style="vertical-align:middle;font-size:15px;font-weight:600;color:#f1f3f8;letter-spacing:.01em;">{_e(service)}</td>
</tr></table></td></tr>
<tr><td style="background:#ffffff;padding:26px 22px 8px 22px;">
<span style="display:inline-block;padding:3px 11px;border-radius:11px;background:{tint};color:{colour};font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;">{_e(word)}</span>
<h1 style="margin:12px 0 16px 0;font-size:22px;line-height:1.3;color:#1d2330;font-weight:700;">{_e(title)}</h1>
{body}</td></tr>
<tr><td style="background:#ffffff;padding:0 22px 22px 22px;border-radius:0 0 12px 12px;">
<div style="border-top:1px solid #e6e9ef;padding-top:14px;font-size:12px;line-height:1.5;color:#8a93a6;">{_e(footer)}</div>
</td></tr></table></td></tr></table></body></html>"""

    rule = "-" * 60
    # The first lines are what inbox previews show, so they carry the message, not decoration.
    plain = [f"{title} ({word.lower()})", ""]
    if context.get("Lead"):
        plain += [str(context["Lead"]).strip(), ""]
    facts = context.get("Facts") or []
    if facts:
        width = max(len(str(label)) for label, _ in facts)
        plain += [f"  {str(label).ljust(width)}  {value}" for label, value in facts] + [""]
    rows = context.get("Rows") or []
    if rows:
        plain += ["Results", "-------"]
        for name, outcome in rows:
            text = str(outcome)
            if text.startswith("error"):
                plain.append(f"  [ERROR] {name} - {text[6:].strip()}")
            else:
                plain.append(f"  [OK]    {name} ({text})")
        plain.append("")
    if context.get("Notes"):
        plain += ["Notes", "-----"] + [f"  {line}" for line in context["Notes"]] + [""]
    if context.get("Pre"):
        label = context.get("PreLabel", "Output")
        plain += [label, "-" * len(label)] + ["  " + line for line in str(context["Pre"]).splitlines()] + [""]
    if context.get("Diff"):
        plain += ["File changes", "------------", str(context["Diff"]).rstrip(), ""]
    plain += [rule, footer]
    return html_text, "\n".join(plain)
