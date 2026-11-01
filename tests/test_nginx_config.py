import copy
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import nginx_config as nc  # noqa: E402

SAMPLE = """# main site
worker_processes auto;  # tuned later

http {
    include /etc/nginx/conf.d/*.conf;

    server {
        listen 80;
        server_name example.com www.example.com _;
        # keep this comment
        location ~ ^/api/(.*)$ {
            proxy_pass http://127.0.0.1:3000;
            add_header X-Custom "a; b { c }";
        }
        if ($host = 'old.example.com') {
            return 301 https://example.com$request_uri;
        }
    }
}
"""


class RoundTrip(unittest.TestCase):
    def test_unedited_document_renders_identically(self):
        self.assertEqual(nc.render(nc.parse(SAMPLE)), SAMPLE)

    def test_empty_document(self):
        self.assertEqual(nc.render(nc.parse("")), "")
        self.assertEqual(nc.render(nc.parse("# only a comment\n")), "# only a comment\n")

    def test_unterminated_quote_is_rejected(self):
        with self.assertRaises(nc.ParseError):
            nc.parse('server_name "example.com;')

    def test_missing_semicolon_is_rejected(self):
        with self.assertRaises(nc.ParseError):
            nc.parse("server { listen 80 }")

    def test_unclosed_block_is_rejected(self):
        with self.assertRaises(nc.ParseError):
            nc.parse("server { listen 80;")

    def test_stray_close_brace_is_rejected(self):
        with self.assertRaises(nc.ParseError):
            nc.parse("listen 80; }")


class Editing(unittest.TestCase):
    def test_editing_a_directive_changes_only_that_statement(self):
        doc = nc.parse(SAMPLE)
        listen = next(n for n in nc.walk(doc["children"]) if n["name"] == "listen")
        listen["args"] = ["8080"]
        listen["dirty"] = True
        out = nc.render(doc)
        self.assertIn("        listen 8080;", out)
        self.assertIn("# keep this comment", out)
        self.assertEqual(out.replace("listen 8080;", "listen 80;"), SAMPLE)

    def test_adding_a_block_and_directive(self):
        doc = nc.parse("http {\n    server_name a.test;\n}\n")
        http = doc["children"][0]
        new_block = {
            "name": "server", "args": [], "block": True, "lead": "\n    ", "text": "",
            "closing": "\n    ", "dirty": True, "children": [
                {"name": "listen", "args": ["80"], "block": False, "lead": "\n        ",
                 "text": "", "closing": "", "dirty": True, "children": []},
            ],
        }
        http["children"].append(new_block)
        out = nc.render(doc)
        self.assertEqual(
            out,
            "http {\n    server_name a.test;\n    server {\n        listen 80;\n    }\n}\n",
        )
        self.assertEqual(nc.parse(out)["children"][0]["children"][1]["name"], "server")

    def test_removing_a_directive(self):
        doc = nc.parse(SAMPLE)
        copy_doc = copy.deepcopy(doc)
        http = copy_doc["children"][1]
        http["children"] = [c for c in http["children"] if c["name"] != "include"]
        self.assertNotIn("include", nc.render(copy_doc))


class ServerNames(unittest.TestCase):
    def test_extracts_hostnames_only(self):
        self.assertEqual(
            nc.server_names(SAMPLE),
            ["example.com", "www.example.com"],
        )

    def test_ignores_bad_input(self):
        self.assertEqual(nc.server_names("server_name {"), [])

    def test_ignores_ips_and_wildcards(self):
        src = "server { server_name 10.0.0.1 *.example.com ~^x\\.com$ localhost Api.Example.org; }"
        self.assertEqual(nc.server_names(src), ["api.example.org"])


if __name__ == "__main__":
    unittest.main()
