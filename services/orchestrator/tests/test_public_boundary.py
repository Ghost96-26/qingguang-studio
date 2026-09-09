from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.requests import Request
from services.orchestrator.workbench import api
from services.orchestrator.workbench.auth import AuthStore
from services.orchestrator.workbench.store import JobStore
from services.orchestrator.workbench.request_security import AuthRateLimiter, is_direct_local


class PublicBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.store = JobStore(root / 'test.db', root / 'tenants'); self.store.initialize()
        self.auth = AuthStore(root / 'test.db'); self.auth.initialize()
        self.stack.enter_context(patch.object(api, 'store', self.store))
        self.stack.enter_context(patch.object(api, 'auth_store', self.auth))
        self.stack.enter_context(patch.object(api, 'auth_limiter', AuthRateLimiter()))
        self.stack.enter_context(patch.object(api.Settings, 'public_edge_secret', new='synthetic-edge-secret'))

    def client(self, **kwargs):
        # Never enter the lifespan: no worker, no GPU.
        headers = {'X-Qingguang-Edge-Secret': 'synthetic-edge-secret'}
        headers.update(kwargs.pop('headers', {}))
        client = TestClient(api.app, headers=headers, **kwargs); self.addCleanup(client.close)
        return client

    def test_direct_tunnel_origin_requires_edge_authentication(self):
        client = TestClient(api.app, base_url='https://random.trycloudflare.com', client=('127.0.0.1', 1000))
        self.addCleanup(client.close)
        self.assertEqual(client.get('/health').status_code, 403)

    def test_tunnel_peer_and_public_host_never_auto_login(self):
        client = self.client(base_url='https://studio.example.com', client=('127.0.0.1', 1000))
        self.assertEqual(client.get('/v1/local-auth').status_code,403)
        self.assertFalse(client.get('/v1/auth/status').json()['local_auto_login'])
        self.assertEqual(client.get('/v1/projects').status_code,401)

    def test_proxy_headers_disable_local_bypass_even_with_local_host(self):
        for header in ['cf-connecting-ip','forwarded','x-forwarded-for','x-forwarded-proto','cf-ray']:
            client=self.client(base_url='http://localhost',client=('127.0.0.1',1000),headers={header:'127.0.0.1'})
            self.assertEqual(client.get('/v1/local-auth').status_code,403,header)

    def test_direct_local_login_still_works(self):
        client=self.client(base_url='http://localhost',client=('127.0.0.1',1000))
        self.assertEqual(client.get('/v1/local-auth').status_code,200)
        self.assertEqual(client.get('/v1/projects').status_code,200)

    def test_remote_health_is_redacted_and_debug_routes_blocked(self):
        client=self.client(base_url='https://studio.example.com',client=('127.0.0.1',1000))
        r=client.get('/health')
        self.assertEqual(r.json(),{'status':'ok'})
        self.assertEqual(r.headers['cache-control'],'private, no-store')
        for path in ['/docs','/redoc','/openapi.json']:
            self.assertEqual(client.get(path).status_code,403)

    def test_remote_auth_rate_limit_and_origin(self):
        client=self.client(base_url='https://studio.example.com',client=('198.51.100.8',1000))
        body={'email':'missing@example.com','password':'synthetic-password'}
        self.assertEqual(client.post('/v1/auth/login',json=body,headers={'Origin':'https://evil.example'}).status_code,403)
        for _ in range(10):self.assertEqual(client.post('/v1/auth/login',json=body).status_code,401)
        r=client.post('/v1/auth/login',json=body)
        self.assertEqual(r.status_code,429); self.assertEqual(r.headers['retry-after'],'60')

    def test_password_change_revokes_other_sessions(self):
        one=self.auth.local_owner_session(); two=self.auth.local_owner_session()
        principal=self.auth.principal_from_token(one['session_token'])
        self.auth.set_password(principal,'synthetic-strong-password')
        self.assertIsNotNone(self.auth.principal_from_token(one['session_token']))
        self.assertIsNone(self.auth.principal_from_token(two['session_token']))
        remote=self.client(base_url='https://studio.example.com',client=('198.51.100.8',1000))
        r=remote.post('/v1/auth/login',json={'email':principal.email,'password':'synthetic-strong-password'})
        self.assertEqual(r.status_code,200)
        self.assertIn('Secure',r.headers['set-cookie']);self.assertIn('HttpOnly',r.headers['set-cookie'])

    def test_resource_start_requires_platform_admin(self):
        from dataclasses import replace
        viewer=replace(self.auth.local_owner_principal(),organization_role='member')
        with self.assertRaises(api.HTTPException) as caught:
            api.start_comfy_runtime(viewer)
        self.assertEqual(caught.exception.status_code,403)

    def test_global_auth_budget_is_bounded(self):
        limiter=AuthRateLimiter(per_peer=10,global_limit=20)
        for i in range(20):self.assertTrue(limiter.allow(str(i)))
        self.assertFalse(limiter.allow('new-peer'))
