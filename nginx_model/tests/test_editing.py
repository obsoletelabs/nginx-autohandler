import unittest

from ..editing import update_basic, find_node, modernize_http2, RECIPES
from ..parser import parse, render
from ..representation import ModelError
from ..workspace import import_files, generate_files
from ..validation import validate


class EditingTests(unittest.TestCase):
    def document(self, source):
        doc = import_files({'site.conf':source})
        server = doc.files[0].nodes[0]
        return doc, server

    def test_http2_conversion_preserves_other_listener_flags(self):
        doc, server = self.document('server { listen 443 ssl http2 default_server; listen [::]:443 ssl http2 reuseport; custom_module on; }')
        result = update_basic(doc, server.id, {'http2':True})
        output = generate_files(result)['site.conf']
        self.assertIn('listen 443 ssl default_server;', output)
        self.assertIn('listen [::]:443 ssl reuseport;', output)
        self.assertEqual(1, output.count('http2 on;'))
        self.assertIn('custom_module on;', output)
        self.assertIn('http2 default_server', generate_files(doc)['site.conf'])

    def test_listener_port_ssl_and_default_edit_preserves_address_and_extras(self):
        doc, server = self.document('server { listen [::]:80 ipv6only=on; # keep\n location / {} }')
        listener = server.children[0]
        result = update_basic(doc, server.id, {'listeners':[{'id':listener.id,'address':'::','port':443,'ssl':True,'default':True}]})
        self.assertIn('listen [::]:443 ipv6only=on ssl default_server;', generate_files(result)['site.conf'])
        self.assertIn('# keep', generate_files(result)['site.conf'])

    def test_untouched_listener_args_are_identical(self):
        doc, server = self.document('server { listen "[::]:443" ssl http2 reuseport; custom_module on; }')
        before = list(server.children[0].args)
        result = update_basic(doc, server.id, {'listeners':[{'id':server.children[0].id}]})
        self.assertEqual(before, find_node(result,server.id).children[0].args)

    def test_add_and_remove_listener(self):
        doc, server = self.document('server { listen 80; server_name a; location / {} }')
        result = update_basic(doc, server.id, {'listeners':[{'address':'127.0.0.1','port':8080,'ssl':False}]})
        output = generate_files(result)['site.conf']
        self.assertNotIn('listen 80;', output)
        self.assertIn('listen 127.0.0.1:8080;', output)
        self.assertIn('location /', output)

    def test_invalid_port_and_unknown_fields_fail_without_mutating(self):
        doc, server = self.document('server { listen 80; }')
        for patch in [{'listeners':[{'port':70000}]},{'made_up':True}]:
            with self.assertRaises(ModelError): update_basic(doc,server.id,patch)
        self.assertEqual(['80'], server.children[0].args)

    def test_tls_pair_added_together_and_one_missing_is_rejected(self):
        doc, server = self.document('server { listen 443 ssl; custom_module on; }')
        result = update_basic(doc,server.id,{'tls':{'certificate':'/cert folder/cert.pem','key':'/cert folder/key.pem'}})
        output = generate_files(result)['site.conf']
        self.assertIn('ssl_certificate "/cert folder/cert.pem";',output)
        self.assertIn('ssl_certificate_key "/cert folder/key.pem";',output)
        with self.assertRaises(ModelError): update_basic(doc,server.id,{'tls':{'certificate':'/cert','key':''}})
        cleared=update_basic(result,server.id,{'tls':{'certificate':'','key':''}})
        self.assertNotIn('ssl_certificate ', generate_files(cleared)['site.conf'])

    def test_multiple_certificate_pairs_stay_advanced(self):
        doc, server = self.document('server { ssl_certificate /rsa; ssl_certificate /ecdsa; ssl_certificate_key /rsa-key; ssl_certificate_key /ecdsa-key; }')
        with self.assertRaises(ModelError): update_basic(doc,server.id,{'tls':{'certificate':'/new','key':'/new-key'}})
        self.assertEqual(2,len([n for n in server.children if n.name=='ssl_certificate']))

    def test_websocket_toggle_preserves_unrelated_headers_and_code(self):
        doc, server = self.document('server { location / { proxy_pass http://a; proxy_set_header Host $host; custom_block { a b; } } }')
        location=server.children[0]
        enabled=update_basic(doc,location.id,{'websockets':True})
        output=generate_files(enabled)['site.conf']
        self.assertIn('proxy_http_version 1.1;',output)
        self.assertIn('proxy_set_header Upgrade $http_upgrade;',output)
        self.assertIn('proxy_set_header Host $host;',output)
        self.assertIn('custom_block {',output)
        disabled=update_basic(enabled,location.id,{'websockets':False})
        self.assertIn('proxy_set_header Upgrade "";',generate_files(disabled)['site.conf'])
        self.assertIn('proxy_set_header Connection "close";',generate_files(disabled)['site.conf'])

    def test_switching_content_type_retains_custom_and_access_rules(self):
        doc, server = self.document('server { location / { proxy_pass http://a; allow 127.0.0.1; custom_code a; } }')
        result=update_basic(doc,server.children[0].id,{'type':'static','root':'/var/www/html','try_files':'$uri $uri/ =404'})
        output=generate_files(result)['site.conf']
        self.assertNotIn('proxy_pass',output)
        self.assertIn('root /var/www/html;',output)
        self.assertIn('custom_code a;',output)
        self.assertIn('allow 127.0.0.1;',output)

    def test_basic_noop_is_an_exact_document_noop(self):
        doc, server = self.document('server { include snippets/tls.conf; listen 443 ssl; location / { custom_module on; } }')
        self.assertEqual(doc.to_dict(),update_basic(doc,server.id,{}).to_dict())

    def test_all_starters_parse_and_fit_their_declared_context(self):
        for recipe in RECIPES:
            with self.subTest(recipe=recipe['id']):
                doc=import_files({'recipe.conf':recipe['source']},context=recipe['scope'])
                self.assertTrue(validate(doc)['structural_ok'])

    def test_automatic_checker_explains_argument_count_and_legacy_http2(self):
        doc, _ = self.document('server { listen 443 ssl http2; location / { proxy_pass; } }')
        result=validate(doc)
        self.assertFalse(result['structural_ok'])
        self.assertTrue(any(i['severity']=='warning' and 'Legacy' in i['message'] for i in result['issues']))
        self.assertTrue(any('proxy_pass' in i['message'] for i in result['issues']))


if __name__=='__main__':
    unittest.main()
