import json
import os
import pathlib
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import certs  # noqa: E402
import ipsync  # noqa: E402
import logs  # noqa: E402
import notify  # noqa: E402
import server  # noqa: E402
import settings  # noqa: E402
import watcher  # noqa: E402
import whoami  # noqa: E402
from nginx_model import parse, render  # noqa: E402
from nginx_model.representation import Node  # noqa: E402

SAMPLE = """# main site
server {
    listen 80;   # http
    server_name example.com www.example.com _ *.wild.example.com 10.0.0.1;
    location ~ ^/api/(.*)$ {
        proxy_pass http://127.0.0.1:3000;
    }
}
"""


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = pathlib.Path(self.tmp.name) / "settings.json"
        patcher = mock.patch.object(settings, "SETTINGS_FILE", self.file)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for spec in settings.SPECS:
            os.environ.pop(spec.env, None)

    def test_default_then_ui_then_env_wins(self):
        self.assertEqual(settings.get("smtp_port"), 0)
        settings.update({"smtp_port": 2525})
        self.assertEqual(settings.get("smtp_port"), 2525)
        self.assertEqual(settings.source(settings.BY_KEY["smtp_port"]), "ui")
        os.environ["SMTP_PORT"] = "1025"
        self.assertEqual(settings.get("smtp_port"), 1025)
        with self.assertRaises(settings.SettingError):
            settings.update({"smtp_port": 3000})

    def test_empty_env_does_not_lock(self):
        os.environ["SMTP_PORT"] = ""
        settings.update({"smtp_port": 2525})
        self.assertEqual(settings.get("smtp_port"), 2525)

    def test_secrets_are_write_only_in_the_ui_description(self):
        settings.update({"cloudflare_api_token": "super-secret-token"})
        described = {item["key"]: item for item in settings.describe()}
        token = described["cloudflare_api_token"]
        self.assertTrue(token["is_set"])
        self.assertNotIn("value", token)
        self.assertNotIn("super-secret-token", json.dumps(described))
        self.assertEqual(settings.get("cloudflare_api_token"), "super-secret-token")

    def test_clearing_a_ui_value(self):
        settings.update({"discord_webhook_url": "https://example.test/hook"})
        settings.update({"discord_webhook_url": ""})
        self.assertEqual(settings.get("discord_webhook_url"), "")

    @unittest.skipIf(os.name == "nt", "POSIX file modes do not apply on Windows")
    def test_settings_file_is_private(self):
        settings.update({"smtp_password": "pw"})
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)

    def test_bad_values_are_refused(self):
        with self.assertRaises(settings.SettingError):
            settings.update({"smtp_security": "tls-maybe"})
        with self.assertRaises(settings.SettingError):
            settings.update({"not_a_setting": "x"})
        with self.assertRaises(settings.SettingError):
            settings.update({"auto_reload": "yes"})


class NotifyTests(unittest.TestCase):
    def test_discord_and_smtp_are_independent(self):
        received = []

        class Hook(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(204)
                self.end_headers()

            def log_message(self, *args):
                pass

        httpd = HTTPServer(("127.0.0.1", 0), Hook)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        url = f"http://127.0.0.1:{httpd.server_port}/hook"

        values = {
            "discord_webhook_url": url,
            "smtp_enabled": True,
            "smtp_host": "127.0.0.1",
            "smtp_port": 1,            # nothing listens here, so SMTP must fail
            "smtp_security": "none",
            "smtp_to": "x@example.test",
            "smtp_retries": 1,
        }
        real_get = settings.get
        with mock.patch.object(settings, "get", side_effect=lambda key: values[key] if key in values else real_get(key)):
            results = notify.send("subject", "body text")
        self.assertEqual(results["discord"], "ok")
        self.assertTrue(results["smtp"].startswith("error"))
        self.assertEqual(len(received), 1)
        self.assertIn("subject", received[0]["content"])


class FakeSmtp(socketserver.StreamRequestHandler):
    """Just enough SMTP to accept one message and keep it."""
    messages = []

    def reply(self, text):
        self.wfile.write(text.encode() + b"\r\n")

    def handle(self):
        self.reply("220 fake ready")
        data_mode, body = False, []
        for raw in self.rfile:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if data_mode:
                if line == ".":
                    data_mode = False
                    FakeSmtp.messages.append("\n".join(body))
                    self.reply("250 queued")
                else:
                    body.append(line)
                continue
            command = line.split(" ", 1)[0].upper()
            if command in ("EHLO", "HELO"):
                self.reply("250 fake")
            elif command in ("MAIL", "RCPT", "RSET", "NOOP"):
                self.reply("250 ok")
            elif command == "DATA":
                data_mode = True
                self.reply("354 go on")
            elif command == "QUIT":
                self.reply("221 bye")
                return
            else:
                self.reply("502 not supported")


class SmtpDeliveryTests(unittest.TestCase):
    def test_ip_change_email_reaches_the_server(self):
        FakeSmtp.messages.clear()
        server_ = socketserver.ThreadingTCPServer(("127.0.0.1", 0), FakeSmtp)
        threading.Thread(target=server_.serve_forever, daemon=True).start()
        self.addCleanup(server_.server_close)
        self.addCleanup(server_.shutdown)
        values = {"smtp_enabled": True, "smtp_host": "127.0.0.1", "smtp_port": server_.server_address[1],
                  "smtp_security": "none", "smtp_to": "me@example.test", "smtp_from": "app@example.test",
                  "discord_webhook_url": "", "smtp_retries": 1}
        real_get = settings.get
        with mock.patch.object(settings, "get", side_effect=lambda key: values[key] if key in values else real_get(key)):
            sent = notify.ip_changed("192.168.68.71", "192.168.68.72", "fake-whoami", {"a.example.com": "updated"})
        self.assertEqual(sent, {"smtp": "ok"})
        self.assertEqual(len(FakeSmtp.messages), 1)
        message = FakeSmtp.messages[0]
        self.assertIn("IP Address Change Detected", message)
        self.assertIn("192.168.68.72", message)
        self.assertIn("a.example.com", message)


class MailTemplateTests(unittest.TestCase):
    def test_html_is_escaped_and_has_every_section(self):
        import mailtemplate
        html_text, plain = mailtemplate.render({
            "Title": "Config <b>failed</b>", "Status": "bad", "Lead": "Line one\n\nLine two <script>",
            "Facts": [("Host", "web&1")], "Rows": [("a.example.com", "updated"), ("b.example.com", "error: boom <x>")],
            "Notes": ["WARNING careful", "ERROR bad"], "Pre": "nginx: [emerg] oops", "PreLabel": "nginx output",
            "Diff": "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new", "Footer": "bye",
        }, "My Service", "host1", "logo")
        self.assertNotIn("<script>", html_text)
        self.assertNotIn("<b>failed</b>", html_text)
        for needle in ("&lt;script&gt;", "web&amp;1", "Problem", "Updated", "Error", "boom &lt;x&gt;", "cid:logo",
                       "nginx output", "File changes", "#16291f", "#331b1d", "My Service"):
            self.assertIn(needle, html_text)
        for needle in ("Config <b>failed</b>", "Host  web&1", "[OK]    a.example.com (updated)", "[ERROR] b.example.com - boom <x>", "Config <b>failed</b> (problem)","nginx: [emerg] oops", "+new", "bye"):
            self.assertIn(needle, plain)

    def test_message_is_multipart_with_inline_logo(self):
        sent = []
        with mock.patch.object(notify, "smtp_ready", return_value=True), \
                mock.patch.object(notify, "_mail", side_effect=lambda subject, plain, html_body, to=None: sent.append((subject, plain, html_body)) or "ok"):
            result = notify.email({"Subject": "Hello", "Title": "Hello", "Lead": "x"})
        self.assertEqual(result, "ok")
        self.assertEqual(sent[0][0], "Hello")
        self.assertIn("cid:" + notify.LOGO_CID, sent[0][2])

    def test_legacy_body_still_renders(self):
        import mailtemplate
        html_text, _ = mailtemplate.render({"Title": "T", "Body": "<b>raw</b>"}, "S")
        self.assertIn("<b>raw</b>", html_text)


class ReissueAndManualIpTests(unittest.TestCase):
    def test_reissue_refuses_non_acme_names(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(certs, "CONFIG_DIR", tmp):
            with self.assertRaises(certs.CertError):
                certs.reissue("selfsigned-thing")
            with self.assertRaises(certs.CertError):
                certs.reissue("../etc")

    def test_renew_due_only_touches_certificates_inside_the_window(self):
        entries = [{"name": "soon", "kind": "letsencrypt", "days_left": 10},
                   {"name": "later", "kind": "letsencrypt", "days_left": 60},
                   {"name": "own", "kind": "selfsigned", "days_left": 2}]
        values = {"cloudflare_api_token": "x", "cert_renew_days": 14}
        real_get = settings.get
        with tempfile.TemporaryDirectory() as tmp:
            renewal = pathlib.Path(tmp, "renewal")
            renewal.mkdir()
            for name in ("soon", "later", "own"):
                (renewal / f"{name}.conf").write_text("x")
            creds = pathlib.Path(tmp, "creds.ini")
            creds.write_text("x")
            with mock.patch.object(certs, "CONFIG_DIR", tmp), mock.patch.object(certs, "CREDENTIALS", creds),                     mock.patch.object(certs, "inventory", return_value=entries),                     mock.patch.object(settings, "get", side_effect=lambda k: values[k] if k in values else real_get(k)),                     mock.patch.object(certs, "_certbot", return_value=(True, "done")) as certbot:
                ok, output = certs.renew_due()
        self.assertTrue(ok)
        self.assertEqual(certbot.call_count, 1)
        self.assertIn("soon", certbot.call_args[0][0])
        self.assertIn("--force-renewal", certbot.call_args[0][0])
        self.assertIn("soon (10 days left): renewed", output)


class SelfSignedRenewalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.live = pathlib.Path(self.tmp.name, "live")
        for patcher in (mock.patch.object(certs, "CONFIG_DIR", self.tmp.name),
                        mock.patch.object(certs, "LIVE_DIR", lambda: self.live),
                        mock.patch.object(certs, "CREDENTIALS", pathlib.Path(self.tmp.name, "none.ini"))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def entry(self, name, days_left, marker):
        folder = self.live / name
        folder.mkdir(parents=True)
        if marker:
            (folder / certs.SELFSIGNED_MARKER).write_text(json.dumps({"domains": ["a.example.com"], "days": 90}))
        return {"name": name, "kind": "selfsigned", "days_left": days_left, "domains": ["a.example.com"],
                "expires": "2030-01-01"}

    def test_generated_certificate_is_regenerated_with_its_old_settings(self):
        entry = self.entry("mine", 5, True)
        with mock.patch.object(certs, "inventory", return_value=[entry]), \
                mock.patch.object(certs, "make_selfsigned", return_value=entry) as make:
            ok, output = certs.reissue("mine")
        self.assertTrue(ok)
        make.assert_called_once_with(["a.example.com"], "mine", 90)
        self.assertIn("generated again", output)

    def test_only_due_generated_certificates_are_renewed_automatically(self):
        due, fresh, foreign = self.entry("due", 5, True), self.entry("fresh", 80, True), self.entry("foreign", 5, False)
        with mock.patch.object(certs, "inventory", return_value=[due, fresh, foreign]), \
                mock.patch.object(certs, "make_selfsigned", return_value=due) as make:
            ok, output = certs.renew_due()
        self.assertTrue(ok)
        self.assertEqual(make.call_count, 1)
        self.assertIn("due (5 days left): renewed", output)
        self.assertNotIn("foreign", output)

    def test_uploaded_certificates_cannot_be_reissued(self):
        with mock.patch.object(certs, "inventory", return_value=[]):
            with self.assertRaises(certs.CertError):
                certs.reissue("whatever")


@unittest.skipUnless(shutil.which("git"), "git is not installed")
class GitSyncTests(unittest.TestCase):
    def setUp(self):
        import gitsync
        self.gs = gitsync
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = pathlib.Path(self.tmp.name)
        self.remote = base / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.remote)], check=True)
        self.work = base / "work"
        subprocess.run(["git", "clone", "-q", str(self.remote), str(self.work)], check=True, capture_output=True)
        self.commit_file("nginx.conf", "events {}\n")
        values = {"git_repo_url": "https://example.test/x.git", "git_branch": "main", "git_subdir": "", "git_token": "",
                  "git_mode": "both", "git_conflicts": "keep-local", "git_author_name": "t", "git_author_email": "t@t.t",
                  "git_interval_minutes": 0}
        real_get = settings.get
        patches = (mock.patch.object(gitsync, "REPO_DIR", base / "clone"),
                   mock.patch.object(gitsync, "STATE_FILE", base / "state.json"),
                   mock.patch.object(gitsync, "_url", return_value=str(self.remote)),
                   mock.patch.object(settings, "get", side_effect=lambda k: values[k] if k in values else real_get(k)))
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.local = {}
        self.applied = []

    def commit_file(self, name, text):
        (self.work / name).parent.mkdir(parents=True, exist_ok=True)
        (self.work / name).write_text(text, encoding="utf-8", newline="")
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@t"]
        subprocess.run(git + ["-C", str(self.work), "add", "-A"], check=True)
        subprocess.run(git + ["-C", str(self.work), "commit", "-q", "-m", "c"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.work), "push", "-q", "origin", "HEAD:main"], check=True, capture_output=True)

    def apply(self, files):
        self.applied.append(dict(files))
        self.local.update(files)
        return {"ok": True, "saved": True, "reloaded": True, "rolled_back": False, "output": ""}

    def sync(self, direction="pull", prefer=None):
        return self.gs.sync(lambda: dict(self.local), self.apply, prefer=prefer, direction=direction)

    def test_first_pull_keeps_a_differing_local_file_unless_told_otherwise(self):
        self.local = {"nginx.conf": "# mine\n"}
        result = self.sync()
        self.assertEqual(result["pull"]["conflicts"], ["nginx.conf"])
        self.assertEqual(self.applied, [])
        result = self.sync(prefer="repo")
        self.assertEqual(result["pull"]["pulled"], ["nginx.conf"])
        self.assertEqual(self.local["nginx.conf"], "events {}\n")

    def test_later_repository_changes_apply_and_local_only_changes_are_left_for_a_push(self):
        self.sync(prefer="repo")
        self.commit_file("conf.d/site.conf", "server {}\n")
        self.local["nginx.conf"] = "events { }  # edited here\n"
        result = self.sync()
        self.assertEqual(result["pull"]["pulled"], ["conf.d/site.conf"])
        self.assertEqual(result["pull"]["conflicts"], [])
        self.assertEqual(self.local["nginx.conf"], "events { }  # edited here\n")

    def test_edit_on_both_sides_is_a_conflict(self):
        self.sync(prefer="repo")
        self.local["nginx.conf"] = "# local edit\n"
        self.commit_file("nginx.conf", "# repo edit\n")
        result = self.sync()
        self.assertEqual(result["pull"]["conflicts"], ["nginx.conf"])
        self.assertEqual(self.local["nginx.conf"], "# local edit\n")

    def test_rejected_by_nginx_changes_nothing_and_reports(self):
        self.sync(prefer="repo")
        self.commit_file("nginx.conf", "bad\n")
        result = self.gs.sync(lambda: dict(self.local),
                              lambda files: {"ok": False, "output": "nginx: [emerg] bad", "rolled_back": True},
                              direction="pull")
        self.assertFalse(result["ok"])
        self.assertIn("nothing was changed", result["error"])
        self.assertEqual(self.local["nginx.conf"], "events {}\n")

    def test_push_commits_changes_but_never_keys_and_never_deletes(self):
        self.sync(prefer="repo")
        self.local["nginx.conf"] = "events { worker_connections 8; }\n"
        self.local["ssl/site.key"] = "-----BEGIN PRIVATE KEY-----\nabc\n"
        self.local["conf.d/notes.conf"] = "# note\n-----BEGIN RSA PRIVATE KEY-----\n"
        result = self.sync("push")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["push"]["pushed"], ["nginx.conf"])
        self.assertCountEqual(result["push"]["held_back"], ["ssl/site.key", "conf.d/notes.conf"])
        shown = subprocess.run(["git", "-C", str(self.remote), "show", "main:nginx.conf"], capture_output=True,
                               text=True).stdout
        self.assertIn("worker_connections 8", shown)
        tree = subprocess.run(["git", "-C", str(self.remote), "ls-tree", "-r", "--name-only", "main"],
                              capture_output=True, text=True).stdout.split()
        self.assertEqual(tree, ["nginx.conf"])

    def test_push_refuses_when_the_repository_moved_on(self):
        self.sync(prefer="repo")
        self.commit_file("other.conf", "x\n")
        self.local["nginx.conf"] = "# changed\n"
        result = self.sync("push")
        self.assertFalse(result["ok"])
        self.assertIn("Pull first", result["error"])

    def test_token_is_never_shown(self):
        with mock.patch.object(settings, "get", side_effect=lambda k: "sekret" if k == "git_token" else ""):
            self.assertEqual(self.gs._scrub("fatal: https://x:sekret@host/a failed sekret"), "fatal: https://***@host/a failed ***")


class IpConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = pathlib.Path(self.tmp.name)
        for patcher in (mock.patch.object(ipsync, "PERSISTENT_FILE", base / "ip.txt"),
                        mock.patch.object(settings, "SETTINGS_FILE", base / "settings.json"),
                        mock.patch.object(notify, "fire"),
                        mock.patch.object(ipsync.time, "sleep"),
                        mock.patch.object(whoami, "urls", return_value=["http://x/"])):
            patcher.start()
            self.addCleanup(patcher.stop)
        ipsync.write_persistent("8.8.4.4")
        self.client = FakeClient()
        self.sync = ipsync.IpSync(lambda: self.client, lambda: set(), lambda domains, ip: None)
        self.sync.old_ip = "8.8.4.4"

    def test_a_one_off_wrong_answer_changes_nothing(self):
        with mock.patch.object(whoami, "lookup", side_effect=[("1.1.1.1", "a"), ("9.9.9.9", "b")]):
            status = self.sync.run()
        self.assertIn("not confirmed", status["error"])
        self.assertEqual(self.client.moved, [])
        self.assertEqual(ipsync.read_persistent(), "8.8.4.4")

    def test_a_confirmed_change_goes_through(self):
        with mock.patch.object(whoami, "lookup", side_effect=[("1.1.1.1", "a"), ("1.1.1.1", "a")]):
            self.sync.run()
        self.assertEqual(self.client.moved, [("8.8.4.4", "1.1.1.1")])


class AtomicWriteTests(unittest.TestCase):
    def test_content_is_replaced_and_no_temp_file_is_left(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "site.conf"
            target.write_text("old\n", encoding="utf-8", newline="")
            server.atomic_write(target, "new\r\n")
            self.assertEqual(target.read_bytes(), b"new\r\n")
            self.assertEqual([item.name for item in pathlib.Path(tmp).iterdir()], ["site.conf"])

    @unittest.skipIf(os.name == "nt", "POSIX file modes do not apply on Windows")
    def test_file_mode_is_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "site.conf"
            target.write_text("old\n", encoding="utf-8")
            target.chmod(0o640)
            server.atomic_write(target, "new\n")
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)


class OverviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = pathlib.Path(self.tmp.name)
        self.root = base / "conf"
        (self.root / "conf.d").mkdir(parents=True)
        (self.root / "nginx.conf").write_text(
            "events {}\nhttp {\n    include conf.d/*.conf;\n}\n", encoding="utf-8")
        (self.root / "conf.d" / "site.conf").write_text(
            "server {\n    listen 80;\n    server_name a.example.com b.example.com;\n"
            "    location / { proxy_pass http://127.0.0.1:3000; }\n}\n", encoding="utf-8")
        (self.root / "conf.d" / "old.conf.disabled").write_text("server { server_name old.example.com; }\n", encoding="utf-8")
        (self.root / "extra.conf").write_text("server { listen 81; server_name loose.example.com; }\n", encoding="utf-8")
        for patcher in (mock.patch.object(settings, "SETTINGS_FILE", base / "settings.json"),
                        mock.patch.object(certs, "CONFIG_DIR", str(base / "le"))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_enabled_and_disabled_files(self):
        import overview
        data = overview.build(self.root, tracked={"a.example.com"})
        state = {item["path"]: item for item in data["files"]}
        self.assertTrue(state["nginx.conf"]["enabled"])
        self.assertTrue(state["conf.d/site.conf"]["enabled"])
        self.assertEqual(state["conf.d/site.conf"]["role"], "site")
        self.assertFalse(state["conf.d/old.conf.disabled"]["enabled"])
        self.assertFalse(state["extra.conf"]["enabled"])
        self.assertEqual(data["counts"]["enabled"], 2)
        self.assertEqual(data["counts"]["disabled"], 2)

    def test_domains_and_their_files(self):
        import overview
        data = overview.build(self.root, tracked={"a.example.com"})
        domains = {item["name"]: item for item in data["domains"]}
        self.assertTrue(domains["a.example.com"]["enabled"] and domains["a.example.com"]["dns"])
        self.assertFalse(domains["b.example.com"]["dns"])
        self.assertFalse(domains["loose.example.com"]["enabled"])
        self.assertEqual(state_proxy(data), ["http://127.0.0.1:3000"])


def state_proxy(data):
    return next(item for item in data["files"] if item["path"] == "conf.d/site.conf")["servers"][0]["proxy"]


class ZipImportTests(unittest.TestCase):
    @staticmethod
    def make_zip(entries):
        import io
        import zipfile
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        return buffer.getvalue()

    def test_wrapping_folder_is_removed_and_junk_skipped(self):
        raw = self.make_zip({
            "etc-nginx/nginx.conf": "events {}\n",
            "etc-nginx/conf.d/site.conf": "server {}\n",
            "etc-nginx/.git/config": "x",
            "__MACOSX/etc-nginx/._nginx.conf": "x",
            "etc-nginx/logo.png": b"\x89PNG\xff\xfe",
        })
        files, skipped, stripped = server.read_zip(raw)
        self.assertEqual(sorted(files), ["conf.d/site.conf", "nginx.conf"])
        self.assertEqual(stripped, "etc-nginx")
        self.assertEqual(sorted(item["reason"] for item in skipped), ["hidden file", "hidden file", "not a text file"])

    def test_unsafe_paths_are_refused(self):
        raw = self.make_zip({"../evil.conf": "x", "/abs.conf": "ok", "C:/win.conf": "x", "a/../b.conf": "x"})
        files, skipped, _ = server.read_zip(raw)
        self.assertEqual(list(files), ["abs.conf"])
        self.assertEqual(len(skipped), 3)

    def test_not_a_zip(self):
        with self.assertRaises(ValueError):
            server.read_zip(b"definitely not a zip")


class BlockEditorTests(unittest.TestCase):
    def test_unedited_round_trip_keeps_comments_and_tokens(self):
        nodes = parse(SAMPLE)
        out = render(nodes)
        self.assertIn("# main site", out)
        self.assertIn("# http", out)
        block = next(n for n in parse(out) if n.kind == "block")
        names = next(n for n in block.children if n.name == "server_name")
        self.assertIn("*.wild.example.com", names.args)

    def test_json_node_round_trip_through_the_server_helpers(self):
        nodes = [Node.from_dict(asdict(n)) for n in parse(SAMPLE)]
        self.assertEqual(render(nodes), render(parse(SAMPLE)))

    def test_server_names_skip_wildcards_regex_and_ips(self):
        self.assertEqual(server.server_names(SAMPLE), ["example.com", "www.example.com"])

    def test_bad_syntax_is_a_value_error(self):
        with self.assertRaises(ValueError):
            parse("server { listen 80")


class CertificateTests(unittest.TestCase):
    def test_domain_validation(self):
        self.assertEqual(
            certs.validate_domains(["Testing.Nginxloader.olcr.uk", "*.nginxloader.obsoletelabs.net"]),
            ["*.nginxloader.obsoletelabs.net", "testing.nginxloader.olcr.uk"],
        )
        with self.assertRaises(certs.CertError):
            certs.validate_domains(["not a domain"])
        with self.assertRaises(certs.CertError):
            certs.validate_domains(["   "])
        with self.assertRaises(certs.CertError):
            certs.validate_domains(["bad;rm -rf.example.com"])


class CertOutputTests(unittest.TestCase):
    SAMPLE = """Found the following certs:
  Certificate Name: testing.example.com
    Serial Number: abc
    Key Type: ECDSA
    Domains: testing.example.com www.example.com
    Expiry Date: 2027-01-30 10:00:00+00:00 (INVALID: TEST_CERT)
    Certificate Path: /etc/letsencrypt/live/testing.example.com/fullchain.pem
  Certificate Name: real.example.com
    Domains: real.example.com
    Expiry Date: 2027-01-30 10:00:00+00:00 (VALID: 89 days)
"""

    def test_certificates_are_parsed(self):
        items = certs.parse_certificates(self.SAMPLE)
        self.assertEqual([item["name"] for item in items], ["testing.example.com", "real.example.com"])
        self.assertEqual(items[0]["domains"], ["testing.example.com", "www.example.com"])
        self.assertTrue(items[0]["staging"])
        self.assertEqual(items[1]["days_left"], 89)
        self.assertTrue(items[1]["valid"])
        self.assertEqual(certs.parse_certificates("No certificates found."), [])

    def test_known_failures_get_a_plain_reason(self):
        self.assertIn("API token", certs.explain("Error determining zone_id: 6003 Invalid request headers."))
        self.assertIn("contact email", certs.explain("The ACME server believes a@b.c is an invalid email address."))
        self.assertEqual(certs.explain("Saving debug log\nSomething odd happened"), "Something odd happened")


@unittest.skipUnless(shutil.which("openssl"), "openssl is needed")
class OwnCertificateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = pathlib.Path(self.tmp.name)
        for patcher in (mock.patch.object(certs, "CONFIG_DIR", str(base / "le")),
                        mock.patch.object(certs, "WARNED_FILE", base / "warned.json"),
                        mock.patch.object(settings, "SETTINGS_FILE", base / "settings.json"),
                        mock.patch.object(certs, "_reload_nginx")):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_self_signed_is_listed_with_its_names(self):
        made = certs.make_selfsigned(["Test.example.com", "*.example.com"], days=30)
        self.assertEqual(made["name"], "test.example.com")
        self.assertEqual(made["kind"], "selfsigned")
        self.assertEqual(sorted(made["domains"]), ["*.example.com", "test.example.com"])
        self.assertTrue(made["valid"])
        self.assertIn(made["days_left"], (29, 30))
        folder = pathlib.Path(certs.CONFIG_DIR) / "live" / "test.example.com"
        self.assertTrue((folder / "fullchain.pem").is_file() and (folder / "privkey.pem").is_file())
        self.assertEqual([item["name"] for item in certs.inventory()], ["test.example.com"])

    def test_bad_self_signed_requests_are_refused(self):
        with self.assertRaises(certs.CertError):
            certs.make_selfsigned(["a.example.com"], days=0)
        with self.assertRaises(certs.CertError):
            certs.make_selfsigned(["a.example.com"], name="../escape")

    def test_upload_checks_the_key_belongs_to_the_certificate(self):
        certs.make_selfsigned(["one.example.com"], days=30)
        certs.make_selfsigned(["two.example.com"], days=30)
        live = pathlib.Path(certs.CONFIG_DIR) / "live"
        cert_one = (live / "one.example.com" / "fullchain.pem").read_text(encoding="utf-8")
        key_one = (live / "one.example.com" / "privkey.pem").read_text(encoding="utf-8")
        key_two = (live / "two.example.com" / "privkey.pem").read_text(encoding="utf-8")
        with self.assertRaises(certs.CertError):
            certs.store_uploaded("mine", cert_one, key_two)
        with self.assertRaises(certs.CertError):
            certs.store_uploaded("mine", "not a certificate", key_one)
        saved = certs.store_uploaded("mine", cert_one, key_one)
        self.assertEqual(saved["name"], "mine")
        self.assertEqual(saved["domains"], ["one.example.com"])

    def test_delete_removes_the_folder(self):
        certs.make_selfsigned(["gone.example.com"], days=30)
        certs.delete_certificate("gone.example.com")
        self.assertEqual(certs.inventory(), [])
        with self.assertRaises(FileNotFoundError):
            certs.delete_certificate("gone.example.com")

    def test_expiry_warning_is_sent_once_a_day(self):
        certs.make_selfsigned(["soon.example.com"], days=5)
        certs.make_selfsigned(["later.example.com"], days=200)
        sent = []
        self.assertEqual(certs.check_expiry(lambda subject, text: sent.append(subject)), ["soon.example.com"])
        self.assertEqual(certs.check_expiry(lambda subject, text: sent.append(subject)), [])
        self.assertEqual(len(sent), 1)
        self.assertIn("soon.example.com", sent[0])


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.object(settings, "SETTINGS_FILE", pathlib.Path(self.tmp.name) / "settings.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for spec in settings.SPECS:
            os.environ.pop(spec.env, None)

    def test_lets_encrypt_is_the_default_and_has_staging(self):
        self.assertIn("staging", certs.authority(True)[0])
        self.assertNotIn("staging", certs.authority(False)[0])

    def test_zerossl_needs_eab_keys_and_has_no_staging(self):
        settings.update({"acme_provider": "zerossl"})
        with self.assertRaises(certs.CertError):
            certs.authority(True)
        with self.assertRaises(certs.CertError):
            certs.authority(False)
        settings.update({"acme_eab_kid": "kid", "acme_eab_hmac_key": "hmac"})
        url, args = certs.authority(False)
        self.assertEqual(url, "https://acme.zerossl.com/v2/DV90")
        self.assertIn("--eab-kid", args)

    def test_custom_server_needs_a_url(self):
        settings.update({"acme_provider": "custom"})
        with self.assertRaises(certs.CertError):
            certs.authority(False)
        settings.update({"acme_directory_url": "https://ca.internal/acme/directory"})
        self.assertEqual(certs.authority(False)[0], "https://ca.internal/acme/directory")


@unittest.skipUnless(shutil.which("openssl"), "openssl is needed")
class ExternalCertificateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = pathlib.Path(self.tmp.name)
        self.external = base / "certs"
        self.external.mkdir()
        for patcher in (mock.patch.object(certs, "CONFIG_DIR", str(base / "le")),
                        mock.patch.object(settings, "SETTINGS_FILE", base / "settings.json"),
                        mock.patch.object(certs, "_reload_nginx")):
            patcher.start()
            self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {"EXTERNAL_CERT_DIRS": str(self.external)})
        env.start()
        self.addCleanup(env.stop)

    def make_pair(self, folder, cert_name, key_name, host):
        folder.mkdir(parents=True, exist_ok=True)
        made = certs.make_selfsigned([host], days=60)
        live = pathlib.Path(certs.CONFIG_DIR) / "live" / made["name"]
        (folder / cert_name).write_bytes((live / "fullchain.pem").read_bytes())
        (folder / key_name).write_bytes((live / "privkey.pem").read_bytes())
        certs.delete_certificate(made["name"])

    def test_folder_and_loose_pairs_are_listed_read_only(self):
        self.make_pair(self.external / "site-a", "tls.crt", "tls.key", "a.example.com")
        self.make_pair(self.external, "loose.crt", "loose.key", "b.example.com")
        found = {item["name"]: item for item in certs.inventory()}
        self.assertEqual(set(found), {"site-a", "loose"})
        self.assertTrue(all(item["kind"] == "external" and item["read_only"] for item in found.values()))
        self.assertEqual(found["site-a"]["domains"], ["a.example.com"])
        self.assertTrue(found["site-a"]["key_path"].endswith("tls.key"))

    def test_external_certificates_cannot_be_deleted_here(self):
        self.make_pair(self.external / "site-a", "fullchain.pem", "privkey.pem", "a.example.com")
        with self.assertRaises(certs.CertError):
            certs.delete_certificate("site-a")
        self.assertTrue((self.external / "site-a" / "fullchain.pem").exists())


class LogReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = pathlib.Path(self.tmp.name)
        self.nginx_dir = base / "nginx"
        self.nginx_dir.mkdir()
        (self.nginx_dir / "access.log").write_text("GET /a 200\nGET /b 404\nGET /c 200\n", encoding="utf-8")
        (self.nginx_dir / "secret.conf").write_text("nope", encoding="utf-8")
        for patcher in (mock.patch.object(logs, "NGINX_LOG_DIR", self.nginx_dir),
                        mock.patch.object(settings, "DATA_DIR", base / "data")):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_only_log_files_are_listed(self):
        self.assertEqual([item["id"] for item in logs.listing()], ["nginx/access.log"])

    def test_tail_and_filter(self):
        self.assertEqual(logs.tail("nginx/access.log", 2)["lines"], ["GET /b 404", "GET /c 200"])
        self.assertEqual(logs.tail("nginx/access.log", 10, "404")["lines"], ["GET /b 404"])

    def test_other_paths_are_refused(self):
        for bad in ("nginx/secret.conf", "nginx/../access.log", "../etc/passwd", "other/access.log", ""):
            with self.assertRaises((ValueError, FileNotFoundError)):
                logs.tail(bad)

    def test_big_logs_are_rotated(self):
        reopened = []
        with mock.patch.object(logs, "ROTATE_BYTES", 10):
            self.assertTrue(logs.rotate_once(lambda: reopened.append(1)))
        self.assertTrue((self.nginx_dir / "access.log.1").exists())
        self.assertFalse((self.nginx_dir / "access.log").exists())
        self.assertEqual(reopened, [1])


class WorkspaceApplyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = pathlib.Path(self.tmp.name)
        self.root = base / "conf"
        self.root.mkdir()
        self.main = self.root / "nginx.conf"
        self.original = "events {\n    worker_connections 1024;\n}\n"
        self.main.write_text(self.original, encoding="utf-8")
        patchers = [
            mock.patch.object(server, "CONF_ROOT", self.root),
            mock.patch.object(server, "BACKUP_DIR", base / "backups"),
            mock.patch.object(server, "notify_safe"),
            mock.patch.object(server, "get_cf", return_value=None),
            mock.patch.object(server, "nginx", return_value=(True, "")),
        ]
        started = [patcher.start() for patcher in patchers]
        for patcher in patchers:
            self.addCleanup(patcher.stop)
        self.nginx = started[-1]

    def test_unchanged_files_are_left_alone(self):
        result = server.apply_workspace({"nginx.conf": server.baseline(self.original)})
        self.assertFalse(result["saved"])
        self.assertEqual(result["changed"], [])
        self.assertEqual(self.main.read_text(encoding="utf-8"), self.original)

    def test_changed_file_is_written_and_reloaded(self):
        changed = "events {\n    worker_connections 2048;\n}\n"
        result = server.apply_workspace({"nginx.conf": changed})
        self.assertTrue(result["ok"] and result["saved"] and result["reloaded"])
        self.assertEqual(result["changed"], ["nginx.conf"])
        self.assertEqual(self.main.read_text(encoding="utf-8"), changed)
        self.nginx.assert_any_call("-s", "reload")

    def test_rejected_test_restores_every_file(self):
        self.nginx.return_value = (False, "unknown directive")
        extra = self.root / "extra.conf"
        result = server.apply_workspace({"nginx.conf": "events {}\n", "extra.conf": "server {}\n"})
        self.assertFalse(result["ok"])
        self.assertTrue(result["rolled_back"])
        self.assertEqual(self.main.read_text(encoding="utf-8"), self.original)
        self.assertFalse(extra.exists())

    def test_files_can_be_deleted_and_come_back_on_rollback(self):
        extra = self.root / "extra.conf"
        extra.write_text("server {}\n", encoding="utf-8")
        keep = {"nginx.conf": server.baseline(self.original)}
        result = server.apply_workspace(keep, ["extra.conf"])
        self.assertTrue(result["ok"] and result["saved"])
        self.assertEqual(result["deleted"], ["extra.conf"])
        self.assertFalse(extra.exists())

        extra.write_text("server {}\n", encoding="utf-8")
        self.nginx.return_value = (False, "rejected")
        result = server.apply_workspace(keep, ["extra.conf"])
        self.assertTrue(result["rolled_back"])
        self.assertEqual(extra.read_text(encoding="utf-8"), "server {}\n")

    def test_main_config_cannot_be_deleted(self):
        with self.assertRaises(ValueError):
            server.apply_workspace({}, ["nginx.conf"])


class WhoamiTests(unittest.TestCase):
    def test_traefik_whoami_format(self):
        text = "Name: lab\nHostname: abc\nRemoteAddr: 8.8.4.4:5555\nGET / HTTP/1.1\n"
        self.assertEqual(whoami.parse_response(text), ("8.8.4.4", "lab"))

    def test_forwarded_for_wins_over_remote_addr(self):
        text = "RemoteAddr: 10.0.0.2:1\nX-Forwarded-For: 8.8.8.8, 10.0.0.2\n"
        self.assertEqual(whoami.parse_response(text)[0], "8.8.8.8")

    def test_bare_ip_and_garbage(self):
        self.assertEqual(whoami.parse_response("1.1.1.1\n"), ("1.1.1.1", None))
        self.assertEqual(whoami.parse_response("<html>nope</html>"), (None, None))

    def test_ipv6_remote_addr(self):
        self.assertEqual(whoami.parse_response("RemoteAddr: [2001:4860::1]:80")[0], "2001:4860::1")

    def test_private_detection(self):
        self.assertTrue(whoami.is_private("192.168.1.5"))
        self.assertFalse(whoami.is_private("8.8.4.4"))


class FakeClient:
    def __init__(self):
        self.moved = []
        self.set = []

    def replace_ip(self, old, new):
        self.moved.append((old, new))
        return {"a.example.com": "updated"}

    def set_a(self, host, ip):
        self.set.append((host, ip))
        return "unchanged"


class IpSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.file = pathlib.Path(self.tmp.name) / "persistent_ip.txt"
        self.settings_file = pathlib.Path(self.tmp.name) / "settings.json"
        for patcher in (mock.patch.object(ipsync, "PERSISTENT_FILE", self.file),
                        mock.patch.object(settings, "SETTINGS_FILE", self.settings_file),
                        mock.patch.object(notify, "fire"),
                        mock.patch.dict(os.environ, {}, clear=False)):
            patcher.start()
            self.addCleanup(patcher.stop)
        for spec in settings.SPECS:
            os.environ.pop(spec.env, None)
        sleeper = mock.patch.object(ipsync.time, "sleep")
        sleeper.start()
        self.addCleanup(sleeper.stop)
        self.client = FakeClient()
        self.remembered = []
        self.sync = ipsync.IpSync(lambda: self.client, lambda: {"b.example.com"},
                                  lambda domains, ip: self.remembered.append((sorted(domains), ip)))

    def run_with(self, ip, source="test"):
        with mock.patch.object(whoami, "lookup", return_value=(ip, source)), \
                mock.patch.object(whoami, "urls", return_value=["http://x/"]):
            return self.sync.run()

    def test_first_run_records_the_ip_and_moves_nothing(self):
        status = self.run_with("8.8.4.4")
        self.assertIsNone(status["error"])
        self.assertEqual(ipsync.read_persistent(), "8.8.4.4")
        self.assertEqual(self.client.moved, [])
        self.assertEqual(self.client.set, [("b.example.com", "8.8.4.4")])

    def test_a_change_moves_records_remembers_and_announces(self):
        self.run_with("8.8.4.4")
        notify.fire.reset_mock()
        status = self.run_with("1.1.1.1", "fake whoami")
        self.assertEqual(self.client.moved, [("8.8.4.4", "1.1.1.1")])
        self.assertEqual(ipsync.read_persistent(), "1.1.1.1")
        self.assertEqual(status["results"]["a.example.com"], "updated")
        self.assertIn(notify.ip_changed, [call.args[0] for call in notify.fire.call_args_list])

    def test_public_to_private_is_refused(self):
        self.run_with("8.8.4.4")
        self.run_with("192.168.1.9")
        self.assertEqual(ipsync.read_persistent(), "8.8.4.4")
        self.assertEqual(self.client.moved, [])

    def test_no_answer_is_reported_as_an_error(self):
        self.assertEqual(self.run_with(None)["error"], "no whoami URL answered")


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = pathlib.Path(self.tmp.name)
        self.root = base / "conf"
        self.root.mkdir()
        self.file = self.root / "nginx.conf"
        self.file.write_text("events {}\n", encoding="utf-8", newline="")
        self.events = []
        self.ok = True
        patcher = mock.patch.object(settings, "SETTINGS_FILE", base / "settings.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.watch = watcher.Watcher(lambda: self.root, lambda *args: (self.ok, "out"), threading.RLock(),
                                     base / "good", lambda *args: self.events.append(args[-1]))
        self.watch.known = self.watch.scan()
        self.watch.accept(True)

    def edit(self, text):
        self.file.write_text(text, encoding="utf-8", newline="")

    def test_good_edit_reloads_and_becomes_the_baseline(self):
        self.edit("events { worker_connections 8; }\n")
        self.assertEqual(self.watch.process(), "reloaded")
        self.assertEqual(self.watch.good["nginx.conf"], b"events { worker_connections 8; }\n")

    def test_bad_edit_is_not_reloaded(self):
        self.ok = False
        self.edit("garbage\n")
        self.assertEqual(self.watch.process(), "test_failed")
        self.assertEqual(self.watch.good["nginx.conf"], b"events {}\n")

    def test_going_back_is_a_revert(self):
        self.edit("x\n")
        self.ok = False
        self.watch.process()
        self.ok = True
        self.edit("events {}\n")
        self.assertEqual(self.watch.process(), "reverted")

    def test_applied_writes_are_not_reported_twice(self):
        self.edit("events { worker_connections 4; }\n")
        self.watch.accept(True)
        self.assertIsNone(self.watch.process())
        self.assertEqual(self.events, [])

    def test_diff_text(self):
        diff = watcher.diff_text("a.conf", "one\n", "two\n")
        self.assertIn("-one", diff)
        self.assertIn("+two", diff)
        self.assertIn("/dev/null", watcher.diff_text("new.conf", None, "x\n"))


class SettingsAliasTests(unittest.TestCase):
    def test_updater_env_names_are_honoured(self):
        with mock.patch.dict(os.environ, {"WHOAMI_URLS": "a.example.com, b.example.com"}):
            self.assertEqual(whoami.configured()[:2], ["a.example.com", "b.example.com"])


class ConfigEventTests(unittest.TestCase):
    def capture(self, diff):
        sent = []
        real_get = settings.get
        values = {"discord_webhook_url": "http://127.0.0.1:9/h", "use_embeds": True, "smtp_enabled": False}

        def post(url, payload, attachment=None):
            sent.append((payload, attachment))
            return "ok"

        with mock.patch.object(settings, "get", side_effect=lambda key: values[key] if key in values else real_get(key)), \
                mock.patch.object(notify, "_post", side_effect=post):
            notify.config_event("title", "message", notify.GREEN, "", diff)
        return sent[0]

    def test_small_diff_is_inline(self):
        payload, attachment = self.capture("-a\n+b\n")
        self.assertIsNone(attachment)
        self.assertIn("```diff", payload["embeds"][0]["description"])

    def test_large_diff_is_attached(self):
        payload, attachment = self.capture("+x\n" * 2000)
        self.assertIsNotNone(attachment)
        self.assertNotIn("```diff", payload["embeds"][0]["description"])


if __name__ == "__main__":
    unittest.main()
