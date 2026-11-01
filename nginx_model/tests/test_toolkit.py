from dataclasses import asdict
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ..parser import parse, render, lex, ParseError
from ..representation import Document, ModelError
from ..workspace import import_files, import_directory, effective_config, generate_files, write_files
from ..storage import DocumentStore, ConflictError
from ..validation import validate, scope_information


def shape(nodes):
    return [(n.kind, n.name, n.args, n.text, shape(n.children)) for n in nodes]


class ParserTests(unittest.TestCase):
    def test_roundtrip_full_language_and_no_invented_defaults(self):
        source = r'''
# a comment
map $http_upgrade $connection_upgrade { default upgrade; "" close; }
server {
    listen [2001:db8::1]:443 ssl reuseport;
    server_name ~^www\.(?<domain>.+)$;
    ssl_certificate /certs/${domain}/fullchain.pem;
    add_header Set-Cookie "a=b" always;
    add_header Set-Cookie 'c=d' always;
    location ~ "^/foo{1,3}/" {
        custom_module 'a;{}#b';
        proxy_set_header Content-Length "";
        proxy_set_header X-Quote "escaped \"quoted\" text";
        set $fragment foo#bar;
        set $escaped escaped\ space;
        if ($uri ~ ^/login) { return 302 https://example.test; }
        proxy_pass http://unix:/tmp/backend.sock:;
    }
    location @error { default_type text/plain; return 486 "hello; world"; }
}
'''
        original = parse(source)
        output = render(original)
        self.assertEqual(shape(original), shape(parse(output)))
        self.assertEqual([(t.kind, t.text) for t in lex(source) if t.kind != "comment"],
                         [(t.kind, t.text) for t in lex(output) if t.kind != "comment"])
        self.assertNotIn("proxy_read_timeout", output)
        self.assertNotIn("X-Real-IP", output)

    def test_comments_and_multiline_arguments(self):
        source = 'server_name\n# between words\nexample.test; # inline\nset $a "line one\nline two";\n'
        self.assertEqual(shape(parse(source)), shape(parse(render(parse(source)))))
        self.assertIn('# inline', render(parse(source)))

    def test_reject_incomplete_configs_with_path_and_line(self):
        for source in ['server {', 'server_name a', 'return "a;', '}', 'server { return 200 }', 'set $a ${bad;']:
            with self.subTest(source=source), self.assertRaises(ParseError) as raised:
                parse(source, 'bad.conf')
            self.assertIn('bad.conf:', str(raised.exception))

    def test_depth_guard(self):
        with self.assertRaises(ParseError):
            parse('a {' * 102 + '}' * 102)

    def test_empty_and_quoted_empty(self):
        self.assertEqual([], parse(' \n'))
        self.assertEqual(['X', '""'], parse('proxy_set_header X "";')[0].args)


class DocumentTests(unittest.TestCase):
    def test_json_roundtrip_and_disabled_generation(self):
        doc = import_files({'site.conf': 'server { listen 80; }'})
        self.assertFalse(doc.enabled)
        copy = Document.from_json(doc.to_json())
        self.assertEqual(doc.to_dict(), copy.to_dict())
        self.assertEqual('server {\n    listen 80;\n}\n', generate_files(copy)['site.conf'])

    def test_strict_json_does_not_discard_data_or_allow_token_injection(self):
        original = import_files({'site.conf': 'listen 80;'}).to_dict()
        for alteration in ('unknown', 'schema', 'token', 'duplicates', 'path', 'extra_children', 'alias'):
            raw = json.loads(json.dumps(original))
            if alteration == 'unknown': raw['certdir'] = '/ignored'
            if alteration == 'schema': raw['schema_version'] = 0
            if alteration == 'token': raw['files'][0]['nodes'][0]['args'] = ['80; include stolen.conf']
            if alteration == 'duplicates': raw['files'][0]['nodes'] *= 2
            if alteration == 'path': raw['files'][0]['path'] = '../live.conf'
            if alteration == 'extra_children': raw['files'][0]['nodes'][0]['children'] = [{'kind':'comment','text':'# not legal here'}]
            if alteration == 'alias': raw['files'].append({'path':'/etc/nginx/site.conf','nodes':[]})
            with self.subTest(alteration=alteration), self.assertRaises((ModelError, ParseError)):
                Document.from_dict(raw)

    def test_header_duplicates_order_and_error_return(self):
        source = 'server { add_header Set-Cookie a always; add_header Set-Cookie b; location @err { default_type text/plain; return 486 "no"; } }'
        doc = import_files({'site.conf':source})
        generated = generate_files(doc)['site.conf']
        self.assertLess(generated.index('Set-Cookie a'), generated.index('Set-Cookie b'))
        self.assertIn('default_type text/plain;', generated)
        self.assertIn('return 486 "no";', generated)


class IncludeTests(unittest.TestCase):
    def test_include_file_inherits_its_insertion_context(self):
        doc = import_files({'site.conf':'server { location / { include snippets/proxy.conf; } }',
                            'snippets/proxy.conf':'proxy_pass http://backend;'}, entrypoint='site.conf')
        scopes, _ = scope_information(doc)
        self.assertEqual(['location'], scopes['file_contexts']['snippets/proxy.conf'])
        self.assertTrue(validate(doc)['structural_ok'])

    def test_known_directive_scope_is_checked_but_unknown_modules_survive(self):
        doc = import_files({'site.conf':'server { location / { listen 80; custom_module on; } }'})
        result = validate(doc)
        self.assertFalse(result['structural_ok'])
        self.assertEqual(1, len(result['issues']))
        self.assertIn('listen is not allowed in location', result['issues'][0]['message'])
        self.assertIn('custom_module on;', generate_files(doc)['site.conf'])

    def test_upstream_servers_and_map_rows_are_not_http_server_blocks(self):
        doc = import_files({'site.conf':'upstream backend { server 127.0.0.1:80; } map $a $b { default 0; server 1; } server { listen 80; }'})
        self.assertTrue(validate(doc)['structural_ok'])

    def test_nested_globs_preserve_original_boundaries_and_insertion(self):
        doc = import_files({'nginx.conf':'events {} http { include conf.d/*.conf; }',
                            'conf.d/b.conf':'server { include snippets/proxy.conf; proxy_pass http://b; }',
                            'conf.d/a.conf':'map $a $b { default 1; }',
                            'snippets/proxy.conf':'proxy_buffering off;',
                            'conf.d/nested/not-matched.conf':'unrelated on;'},
                           entrypoint='nginx.conf', context='main')
        output, issues = effective_config(doc)
        self.assertEqual([], issues)
        self.assertNotIn('include', output)
        self.assertNotIn('unrelated', output)
        self.assertLess(output.index('map'), output.index('server'))
        self.assertLess(output.index('proxy_buffering'), output.index('proxy_pass'))
        self.assertIn('include conf.d/*.conf;', generate_files(doc)['nginx.conf'])
        self.assertEqual(5, len(doc.files))

    def test_absolute_and_quoted_paths(self):
        doc = import_files({'root.conf':'include "/etc/nginx/common settings.conf";', 'common settings.conf':'gzip off;'})
        self.assertEqual('gzip off;\n', effective_config(doc)[0])

    def test_cycles_and_missing_includes_are_never_silently_dropped(self):
        for files in [{'a.conf':'include b.conf;', 'b.conf':'include a.conf;'}, {'a.conf':'include missing/*.conf;'}]:
            doc = import_files(files)
            with self.assertRaises(ModelError): effective_config(doc)
            result = validate(doc, nginx=True)
            self.assertFalse(result['structural_ok'])
            self.assertEqual('blocked', result['nginx']['status'])

    def test_directory_import_and_extensionless_snippet(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'snippets').mkdir()
            (root/'a.conf').write_text('server { include snippets/common; }')
            (root/'snippets'/'common').write_text('gzip off;')
            doc = import_directory(root)
            self.assertEqual('__workspace__.conf', doc.entrypoint)
            self.assertEqual(3, len(doc.files))
            self.assertIn('gzip off;', effective_config(doc)[0])

    def test_synthetic_entry_does_not_enable_nested_snippets_as_sites(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'snippets').mkdir()
            (root/'a.conf').write_text('server { location / { include snippets/common.conf; } }')
            (root/'snippets'/'common.conf').write_text('proxy_buffering off;')
            doc = import_directory(root)
            output = effective_config(doc)[0]
            self.assertEqual(1, output.count('proxy_buffering off;'))
            self.assertTrue(validate(doc)['structural_ok'])


class StorageExportValidationTests(unittest.TestCase):
    def test_atomic_store_revisions_and_stale_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DocumentStore(directory)
            doc = import_files({'site.conf':'server {}'})
            saved = store.save(doc)
            self.assertEqual(1, saved.revision)
            with self.assertRaises(ConflictError): store.save(doc)
            saved.name = 'Edited'
            self.assertEqual(2, store.save(saved).revision)
            self.assertEqual('Edited', store.list()[0]['name'])
            self.assertEqual(2, store.load(saved.id).revision)

    def test_export_disabled_documents_and_refuse_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            doc = import_files({'/etc/nginx/a.conf':'server { listen 80; }'})
            paths = write_files(doc, directory)
            self.assertEqual(1, len(paths))
            self.assertTrue(Path(paths[0]).is_relative_to(Path(directory)))
            self.assertIn('listen 80;', Path(paths[0]).read_text())
            with self.assertRaises(FileExistsError): write_files(doc, directory)
            write_files(doc, directory, overwrite=True)

    def test_export_path_collision_and_reserved_name(self):
        with tempfile.TemporaryDirectory() as directory:
            doc = import_files({'/a.conf':'gzip on;', 'a.conf':'gzip off;'})
            with self.assertRaises(ModelError): write_files(doc, directory)
            doc = import_files({'NUL.conf':'gzip on;'})
            with self.assertRaises(ModelError): write_files(doc, directory)

    def test_flat_export_requires_resolved_includes(self):
        with tempfile.TemporaryDirectory() as directory:
            doc = import_files({'a.conf':'include unknown.conf;'})
            with self.assertRaises(ModelError): write_files(doc, directory, flatten=True)

    def test_absent_nginx_is_not_a_validation_pass(self):
        doc = import_files({'a.conf':'server {listen 80;}'})
        with patch('shutil.which', return_value=None):
            result = validate(doc, nginx=True)
        self.assertTrue(result['structural_ok'])
        self.assertEqual('unavailable', result['nginx']['status'])

    def test_nginx_check_uses_a_separate_temporary_config(self):
        doc = import_files({'a.conf':'server {listen 80;}'})
        def fake_run(command, **kwargs):
            self.assertIn('-t', command)
            self.assertNotIn('-s', command)
            temporary_config = Path(command[-1]).read_text()
            self.assertIn('events {}', temporary_config)
            self.assertIn('http {', temporary_config)
            self.assertFalse(kwargs['shell'])
            from types import SimpleNamespace
            return SimpleNamespace(returncode=0, stdout='', stderr='configuration test successful')
        with patch('subprocess.run', side_effect=fake_run):
            self.assertEqual('passed', validate(doc, nginx=True, executable='nginx-test')['nginx']['status'])


if __name__ == '__main__':
    unittest.main()
