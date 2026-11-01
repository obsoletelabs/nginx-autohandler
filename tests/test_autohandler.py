import json
import os
import pathlib
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
import notify  # noqa: E402
import server  # noqa: E402
import settings  # noqa: E402
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
        self.assertEqual(settings.get("smtp_port"), 587)
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

        with mock.patch.object(settings, "get", side_effect=lambda key: {
            "discord_webhook_url": url,
            "smtp_host": "127.0.0.1",
            "smtp_port": 1,            # nothing listens here, so SMTP must fail
            "smtp_security": "none",
            "smtp_username": "",
            "smtp_password": "",
            "smtp_from": "",
            "smtp_to": "x@example.test",
        }[key]):
            results = notify.send("subject", "body text")
        self.assertEqual(results["discord"], "ok")
        self.assertTrue(results["smtp"].startswith("error"))
        self.assertEqual(len(received), 1)
        self.assertIn("subject", received[0]["content"])


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


if __name__ == "__main__":
    unittest.main()
