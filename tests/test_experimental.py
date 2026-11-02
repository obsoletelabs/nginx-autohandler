"""Tests for the experimental branch: sites, features, templates, stats, search, topology, timeline, htpasswd."""

import json
import os
import pathlib
import tempfile
import time
import unittest
from unittest import mock

import test_autohandler  # noqa: F401  (sets the temp data and config folders before the app modules load)
import explore
import features
import htpasswd
import server
import sites
import stats
import templates
import timeline
from nginx_model import parse
from nginx_model.parser import render

SITE = ("server {\n    listen 80;\n    listen [::]:80;\n    server_name app.example.com www.example.com;\n"
        "    location / {\n        proxy_pass http://127.0.0.1:8080/api;\n    }\n}\n")


class SitesTests(unittest.TestCase):
    def test_listing_describes_each_server_block(self):
        two = SITE + "stream {\n    server {\n        listen 5432;\n        proxy_pass db:5432;\n    }\n}\n"
        found = sites.list_sites({"conf.d/a.conf": two})
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["id"], "conf.d/a.conf#0")
        self.assertEqual(found[0]["names"], ["app.example.com", "www.example.com"])
        self.assertEqual(found[0]["forward"], "http://127.0.0.1:8080/api")
        self.assertFalse(found[0]["ssl"])

    def test_names_and_target_change_and_are_checked(self):
        new = sites.update(SITE, 0, "b.example.com", "https://app:9000/x")
        self.assertIn("server_name b.example.com;", new)
        self.assertIn("proxy_pass https://app:9000/x;", new)
        for bad in ("a b; deny all", "x;y", "{"):
            with self.assertRaises(ValueError):
                sites.update(SITE, 0, bad, None)
        with self.assertRaises(ValueError):
            sites.update(SITE, 0, None, "http://host;rm -rf")
        with self.assertRaises(ValueError):
            sites.update("server {\n    server_name a.test;\n    return 200;\n}\n", 0, None, "http://x:1")

    def test_https_moves_listeners_adds_redirect_and_can_be_undone(self):
        secure = sites.enable_https(SITE, 0, "/etc/letsencrypt/live/a/fullchain.pem", "/etc/letsencrypt/live/a/privkey.pem")
        found = sites.list_sites({"a.conf": secure})
        self.assertEqual(len(found), 2)
        self.assertTrue(found[0]["ssl"])
        self.assertEqual(found[0]["certificate"], "/etc/letsencrypt/live/a/fullchain.pem")
        self.assertIn("listen 443 ssl;", secure)
        self.assertIn("return 301 https://$host$request_uri;", secure)
        plain = sites.disable_https(secure, 0)
        self.assertNotIn("ssl_certificate", plain)
        self.assertNotIn("443", plain.split("server {", 2)[1])
        with self.assertRaises(ValueError):
            sites.enable_https(SITE, 0, "relative.pem", "/k.pem")
        with self.assertRaises(ValueError):
            sites.enable_https(SITE, 0, "/a/../../etc/passwd", "/k.pem")

    def test_https_without_redirect_adds_no_second_server(self):
        secure = sites.enable_https(SITE, 0, "/c.pem", "/k.pem", redirect=False)
        self.assertEqual(len(sites.list_sites({"a.conf": secure})), 1)


class FeatureTests(unittest.TestCase):
    def apply_all(self):
        text = SITE
        for feature_id in features.BY_ID:
            values = {"password": "secret"} if feature_id == "basic_auth" else {}
            text = features.apply(text, 0, feature_id, values)
        return text

    def test_every_feature_can_be_turned_on_detected_and_removed(self):
        text = self.apply_all()
        self.assertEqual(sorted(sites.list_sites({"a.conf": text})[0]["features"]), sorted(features.BY_ID))
        self.assertIn("limit_req_zone", text)
        self.assertIn("upstream pool_app_example_com", text)
        self.assertIn("proxy_pass http://pool_app_example_com/api;", text)
        for feature_id in features.BY_ID:
            text = features.disable(text, 0, feature_id)
        self.assertEqual(text, render(parse(SITE)).replace("proxy_pass http://127.0.0.1:8080/api;", "proxy_pass http://10.0.0.11:8080/api;"))

    def test_changing_a_feature_replaces_it_instead_of_stacking(self):
        once = features.apply(SITE, 0, "rate_limit", {"rate": 5, "burst": 1})
        twice = features.apply(once, 0, "rate_limit", {"rate": 50, "burst": 9})
        self.assertEqual(twice.count("limit_req_zone"), 1)
        self.assertIn("rate=50r/s", twice)
        self.assertIn("burst=9", twice)
        self.assertNotIn("rate=5r/s", twice)

    def test_values_are_checked_before_they_reach_the_config(self):
        bad = [("rate_limit", {"rate": "x"}), ("rate_limit", {"rate": 0}), ("cache", {"valid": "10m; evil"}),
               ("cache", {"size": "big"}), ("limits", {"max_body": "1g;"}), ("cors", {"origin": "https://a.com\n;evil"}),
               ("ip_access", {"allow": "1.2.3.4; deny all"}), ("load_balance", {"servers": "host only"}),
               ("load_balance", {"servers": "a:80 evil"}), ("basic_auth", {"realm": 'x"; y', "username": "a", "password": "p"}),
               ("compression", {"level": 12}), ("security_headers", {"preset": "nope"}),
               ("bot_block", {"agents": 'x"; return 200; #'}), ("bot_block", {"agents": ""}), ("ip_block", {"deny": "1.2.3.4; allow all"}),
               ("real_ip", {"preset": "custom", "proxies": ""}), ("real_ip", {"preset": "custom", "proxies": "10.0.0.1\nbogus"}),
               ("real_ip", {"header": "X-Evil"})]
        for feature_id, values in bad:
            with self.assertRaises(ValueError, msg=feature_id):
                features.apply(SITE, 0, feature_id, values)
        with self.assertRaises(ValueError):
            features.apply(SITE, 0, "nonsense", {})

    def test_the_error_page_message_cannot_break_out_of_its_quotes(self):
        text = features.apply(SITE, 0, "error_page", {"message": 'Hi "there" $host \\ ; } {'})
        self.assertNotIn("$host", text)
        parse(text)  # still valid nginx syntax
        self.assertEqual(len(sites.list_sites({"a.conf": text})), 1)

    def test_load_balancing_needs_an_app_to_forward_to(self):
        with self.assertRaises(ValueError):
            features.apply("server {\n    server_name a.test;\n    return 200;\n}\n", 0, "load_balance", {})

    def test_site_slugs_work_for_the_second_block_of_a_file(self):
        two = SITE + SITE.replace("app.example.com www.example.com", "second.example.com")
        text = features.apply(two, 1, "rate_limit", {})
        self.assertIn("zone=rl_second_example_com", text)
        self.assertEqual(sites.list_sites({"a.conf": text})[0]["features"], [])
        self.assertEqual(sites.list_sites({"a.conf": text})[1]["features"], ["rate_limit"])


class HtpasswdTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.object(htpasswd, "folder", lambda: pathlib.Path(self.tmp.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_apr1_matches_openssl(self):
        self.assertEqual(htpasswd.apr1("pässword", "7vIsT.ZV"), "$apr1$7vIsT.ZV$/tgRI8ECOUqvHzbEy3e410")
        self.assertEqual(htpasswd.apr1("a", "abcdefgh"), "$apr1$abcdefgh$G8IsPsylW5ROvIKsQMRG61")

    def test_users_are_added_replaced_and_removed(self):
        htpasswd.set_user("site", "alice", "one")
        htpasswd.set_user("site", "bob", "two")
        htpasswd.set_user("site", "alice", "three")
        self.assertEqual(sorted(htpasswd.users("site")), ["alice", "bob"])
        content = (pathlib.Path(self.tmp.name) / "site").read_text(encoding="utf-8")
        self.assertNotIn("three", content)
        self.assertEqual(content.count("alice:"), 1)
        htpasswd.remove_user("site", "bob")
        self.assertEqual(htpasswd.users("site"), ["alice"])
        with self.assertRaises(FileNotFoundError):
            htpasswd.remove_user("site", "ghost")

    def test_bad_names_and_slugs_are_refused(self):
        for user in ("", "a:b", "a b", "x" * 80):
            with self.assertRaises(ValueError):
                htpasswd.set_user("site", user, "pw")
        with self.assertRaises(ValueError):
            htpasswd.set_user("site", "ok", "")
        with self.assertRaises(ValueError):
            htpasswd.path_for("../etc")


class TemplateTests(unittest.TestCase):
    def test_every_template_builds_valid_nginx(self):
        samples = {"reverse_proxy": {"domain": "a.test", "target": "http://127.0.0.1:1"}, "static_site": {"domain": "b.test", "root": "/srv/b"},
                   "spa": {"domain": "c.test", "root": "/srv/c"}, "redirect": {"domain": "d.test", "target": "https://e.test"},
                   "php": {"domain": "p.test", "root": "/var/www", "backend": "127.0.0.1:9000"},
                   "load_balanced": {"domain": "l.test", "servers": ["a:1", "b:2"]},
                   "api_gateway": {"domain": "g.test", "target": "http://x:3000"}, "maintenance": {"domain": "m.test", "message": "Soon"},
                   "catch_all": {}, "tcp_proxy": {"name": "db", "port": 5432, "target": "10.0.0.5:5432"}}
        self.assertEqual(set(samples), set(templates.BY_ID))
        for template_id, values in samples.items():
            built = templates.build(template_id, values, {"nginx.conf": "events {}\nhttp {\n    include /etc/nginx/conf.d/*.conf;\n}\n"})
            self.assertTrue(built["files"], template_id)
            for path, text in built["files"].items():
                parse(text, path)

    def test_a_domain_and_target_are_checked(self):
        with self.assertRaises(ValueError):
            templates.build("reverse_proxy", {"domain": "a.test; evil", "target": "http://x:1"})
        with self.assertRaises(ValueError):
            templates.build("reverse_proxy", {"domain": "a.test", "target": "x; y"})
        with self.assertRaises(ValueError):
            templates.build("static_site", {"domain": "a.test", "root": "/a/../b"})
        with self.assertRaises(ValueError):
            templates.build("nope", {})

    def test_stream_template_adds_its_include_once(self):
        main = "events {}\nhttp {\n}\n"
        first = templates.build("tcp_proxy", {"name": "db", "port": 5432, "target": "db:5432", "udp": True}, {"nginx.conf": main})
        self.assertIn("listen 5432 udp;", first["files"]["stream.d/db.conf"])
        self.assertIn("include /etc/nginx/stream.d/*.conf;", first["files"]["nginx.conf"])
        second = templates.build("tcp_proxy", {"name": "dns", "port": 53, "target": "1.1.1.1:53"}, {"nginx.conf": first["files"]["nginx.conf"]})
        self.assertNotIn("nginx.conf", second["files"])


LOG = ('203.0.113.5 - - [{t}] "GET /index.html?x=1 HTTP/1.1" 200 512 "-" "Mozilla/5.0"\n'
       '203.0.113.5 - - [{t}] "GET /api/users HTTP/1.1" 502 150 "-" "Mozilla/5.0"\n'
       '198.51.100.9 - - [{t}] "POST /api/users HTTP/1.1" 404 10 "-" "curl/8.0"\n'
       'garbage line\n'
       '198.51.100.9 - - [01/Jan/2001:00:00:00 +0000] "GET /old HTTP/1.1" 200 1 "-" "x"\n')


class StatsTests(unittest.TestCase):
    def test_summary_counts_status_paths_and_ignores_old_lines(self):
        now = time.time()
        stamp = time.strftime("%d/%b/%Y:%H:%M:%S +0000", time.gmtime(now - 60))
        data = stats.summarize(LOG.format(t=stamp).splitlines(), now=now, hours=24)
        self.assertEqual(data["total"], 3)
        self.assertEqual(data["status"], {"2xx": 1, "4xx": 1, "5xx": 1})
        self.assertEqual(data["top_paths"][0], ("/api/users", 2))
        self.assertEqual(data["bytes"], 672)
        self.assertEqual(data["bots"], 1)
        self.assertEqual(data["skipped_lines"], 1)
        self.assertEqual(data["recent_errors"][0]["status"], 502)
        self.assertEqual(sum(item["requests"] for item in data["series"]), 3)
        self.assertEqual(data["last_five_minutes"], 3)

    def test_timestamps_respect_the_time_zone(self):
        self.assertEqual(stats.when("02/Nov/2026:12:00:00 +0100"), stats.when("02/Nov/2026:11:00:00 +0000"))
        self.assertIsNone(stats.when("nonsense"))


class ExploreTests(unittest.TestCase):
    FILES = {"conf.d/a.conf": SITE, "conf.d/b.conf": "server {\n    server_name b.test;\n    root /srv/b;\n}\n",
             "nginx.conf": "events {}\nhttp {\n    upstream pool {\n        server 10.0.0.1:80;\n        server 10.0.0.2:80;\n    }\n"
                           "    server {\n        server_name p.test;\n        location / {\n            proxy_pass http://pool;\n        }\n    }\n}\n"}

    def test_search_finds_lines_and_supports_regex(self):
        found = explore.search(self.FILES, "proxy_pass")
        self.assertEqual({item["file"] for item in found["matches"]}, {"conf.d/a.conf", "nginx.conf"})
        self.assertEqual(explore.search(self.FILES, r"server_name\s+b\.", regex=True)["matches"][0]["file"], "conf.d/b.conf")
        self.assertEqual(explore.search(self.FILES, "PROXY_PASS", case=True)["matches"], [])
        self.assertEqual(explore.search(self.FILES, "  ")["matches"], [])
        with self.assertRaises(ValueError):
            explore.search(self.FILES, "(", regex=True)

    def test_topology_links_domains_sites_pools_and_apps(self):
        data = explore.topology(self.FILES, {"conf.d/a.conf", "nginx.conf"})
        ids = {item["id"] for item in data["nodes"]}
        self.assertIn("domain:app.example.com", ids)
        self.assertIn("pool:pool", ids)
        self.assertIn("app:10.0.0.2:80", ids)
        self.assertIn("folder:/srv/b", ids)
        self.assertIn(["pool:pool", "app:10.0.0.1:80"], data["edges"])
        off = [item for item in data["nodes"] if item["id"] == "domain:b.test"][0]
        self.assertEqual(off["state"], "off")


class TimelineTests(unittest.TestCase):
    def test_events_survive_and_come_back_newest_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(timeline, "file", lambda: pathlib.Path(tmp) / "t.jsonl"):
                for number in range(5):
                    timeline.record({"title": f"event {number}"})
                recent = timeline.recent(3)
                self.assertEqual([item["title"] for item in recent], ["event 4", "event 3", "event 2"])
                (pathlib.Path(tmp) / "t.jsonl").write_text("not json\n" + json.dumps({"title": "x"}) + "\n", encoding="utf-8")
                self.assertEqual(timeline.recent(), [{"title": "x"}])


class ApplyThroughServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = pathlib.Path(self.tmp.name)
        self.root = base / "conf"
        (self.root / "conf.d").mkdir(parents=True)
        (self.root / "nginx.conf").write_text("events {}\nhttp {\n    include /etc/nginx/conf.d/*.conf;\n}\n", encoding="utf-8")
        (self.root / "conf.d" / "a.conf").write_text(SITE, encoding="utf-8")
        for patcher in (mock.patch.object(server, "CONF_ROOT", self.root), mock.patch.object(server, "BACKUP_DIR", base / "backups"),
                        mock.patch.object(server, "notify_safe"), mock.patch.object(server, "get_cf", return_value=None),
                        mock.patch.object(server, "nginx", return_value=(True, "")), mock.patch.object(timeline, "file", lambda: base / "t.jsonl")):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_a_site_change_is_applied_and_logged_on_the_timeline(self):
        result = server.site_change("conf.d/a.conf#0", lambda text, index: sites.update(text, index, "z.example.com", None))
        self.assertTrue(result["saved"])
        self.assertIn("z.example.com", (self.root / "conf.d" / "a.conf").read_text(encoding="utf-8"))
        self.assertEqual(timeline.recent()[0]["kind"], "applied")
        self.assertIn("z.example.com", timeline.recent()[0].get("diff", ""))

    def test_a_rejected_change_is_rolled_back(self):
        before = (self.root / "conf.d" / "a.conf").read_text(encoding="utf-8")
        with mock.patch.object(server, "nginx", side_effect=[(True, ""), (False, "nginx: [emerg] nope in /x:1")]):
            result = server.site_change("conf.d/a.conf#0", lambda text, index: features.apply(text, index, "rate_limit", {}))
        self.assertFalse(result["ok"])
        self.assertEqual((self.root / "conf.d" / "a.conf").read_text(encoding="utf-8"), before)

    def test_unknown_sites_and_paths_are_refused(self):
        with self.assertRaises(ValueError):
            sites.split_id("nohash")
        with self.assertRaises(FileNotFoundError):
            server.site_change("conf.d/missing.conf#0", lambda text, index: text)
        with self.assertRaises(PermissionError):
            server.site_change("../../etc/passwd#0", lambda text, index: text)
        with self.assertRaises(ValueError):
            server.site_change("conf.d/a.conf#9", lambda text, index: sites.update(text, index, "x.test", None))


if __name__ == "__main__":
    unittest.main()
