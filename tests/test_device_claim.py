import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from device_claim import issue_claim, cancel_claim, read_home_code, ClaimError

D='10000000-0000-4000-8000-000000000001'
TOKEN='fake-local-device-token-for-tests-123456'
CODE='sn-claim-'+'a'*32

class DeviceClaimTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        env=patch.dict(os.environ,{'SUPABASE_URL':'https://project.supabase.co','SUPABASE_PUBLISHABLE_KEY':'sb_publishable_test',
            'SAFENEST_DEVICE_ID':D,'SAFENEST_DEVICE_TOKEN':TOKEN},clear=True)
        env.start();self.addCleanup(env.stop)
        self.response=Mock(status_code=200);self.response.json.return_value={'ok':True,'claim_code':CODE,'ttl_seconds':600}
        post=patch('device_claim.requests.post',return_value=self.response);self.post=post.start();self.addCleanup(post.stop)

    def test_explicit_issue_uses_local_credentials_only_over_https_without_redirect_or_disk_storage(self):
        self.post.assert_not_called()
        self.assertEqual(issue_claim(self.root,D),CODE)
        url=self.post.call_args.args[0];kw=self.post.call_args.kwargs
        self.assertEqual(url,'https://project.supabase.co/rest/v1/rpc/issue_device_claim')
        self.assertEqual(kw['json'],{'p_device':D,'p_token':TOKEN})
        self.assertEqual(kw['timeout'],(3,8));self.assertFalse(kw['allow_redirects'])
        self.assertEqual(list(self.root.iterdir()),[])

    def test_missing_or_changed_device_blocks_network(self):
        for value in ['', 'invalid','10000000-0000-4000-8000-000000000002']:
            os.environ['SAFENEST_DEVICE_ID']=value
            with self.assertRaises(ClaimError):issue_claim(self.root,D)
        self.post.assert_not_called()

    def test_insecure_urls_and_privileged_keys_are_rejected(self):
        for url in ['http://project.supabase.co','https://user:pass@project.supabase.co','https://project.supabase.co/path','https://project.supabase.co?token=secret','https://[bad']:
            os.environ['SUPABASE_URL']=url
            with self.assertRaises(ClaimError):issue_claim(self.root,D)
        os.environ['SUPABASE_URL']='https://project.supabase.co'
        for key in ['sb_secret_hidden','',self.jwt('service_role')]:
            os.environ['SUPABASE_PUBLISHABLE_KEY']=key
            with self.assertRaises(ClaimError):issue_claim(self.root,D)
        self.post.assert_not_called()

    @staticmethod
    def jwt(role):
        b=lambda v:base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip('=')
        return b({'alg':'HS256'})+'.'+b({'role':role})+'.test'

    def test_legacy_anon_key_is_supported(self):
        os.environ['SUPABASE_PUBLISHABLE_KEY']=self.jwt('anon');issue_claim(self.root,D)
        self.assertEqual(self.post.call_args.kwargs['headers']['Authorization'],'Bearer '+self.jwt('anon'))

    def test_safe_errors_never_echo_tokens_or_upstream_messages(self):
        for status in [401,403,404,429,500,302]:
            self.response.status_code=status
            with self.assertRaises(ClaimError) as e:issue_claim(self.root,D)
            self.assertNotIn(TOKEN,str(e.exception))
        self.post.side_effect=RuntimeError('unsafe '+TOKEN)
        with self.assertRaises(ClaimError) as e:issue_claim(self.root,D)
        self.assertNotIn(TOKEN,str(e.exception))
        self.assertNotIn(TOKEN,str(e.exception.__cause__))

    def test_server_errors_and_malformed_success_are_rejected(self):
        for error in ['claim_unavailable','rate_limited',TOKEN]:
            self.response.json.return_value={'ok':False,'error':error}
            with self.assertRaises(ClaimError) as e:issue_claim(self.root,D)
            self.assertNotIn(TOKEN,str(e.exception))
        for result in [{'ok':True,'claim_code':TOKEN,'ttl_seconds':600},{'ok':True,'claim_code':CODE,'ttl_seconds':999},[],None]:
            self.response.json.return_value=result
            with self.assertRaises(ClaimError):issue_claim(self.root,D)

    def test_cancel_sends_matching_hash_not_plaintext_code(self):
        import hashlib
        cancel_claim(self.root,D,CODE)
        args=self.post.call_args.kwargs['json']
        self.assertEqual(args['p_code_hash'],hashlib.sha256(CODE.encode()).hexdigest())
        self.assertNotIn(CODE,json.dumps(args))
        self.assertIn('/cancel_device_claim',self.post.call_args.args[0])

    def test_home_lookup_uses_verified_device_and_never_saves_or_displays_credentials(self):
        self.response.json.return_value={'ok':True,'device_id':D,'home_code':'Home-001'}
        self.assertEqual(read_home_code(self.root,D),'Home-001')
        self.assertTrue(self.post.call_args.args[0].endswith('/device_setup_info'))
        self.assertEqual(self.post.call_args.kwargs['json'],{'p_device':D,'p_token':TOKEN})
        self.assertEqual(list(self.root.iterdir()),[])

    def test_home_lookup_rejects_wrong_device_invalid_code_and_missing_migration(self):
        for value in [{'ok':True,'device_id':'another','home_code':'Home-001'}, {'ok':True,'device_id':D,'home_code':'Bedroom'}, {'ok':True,'device_id':D,'home_code':None}]:
            self.response.json.return_value=value
            with self.assertRaises(ClaimError):read_home_code(self.root,D)
        self.response.status_code=404
        with self.assertRaisesRegex(ClaimError,'home_identity.sql'):read_home_code(self.root,D)

if __name__=='__main__':unittest.main()
