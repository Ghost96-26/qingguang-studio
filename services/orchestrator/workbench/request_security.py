"""Network-boundary checks. Proxy traffic must never inherit local owner access."""
from __future__ import annotations

import ipaddress
import threading
import time
from collections import deque

from starlette.requests import Request


PROXY_HEADERS = ("forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "cf-connecting-ip", "cf-ray", "cf-access-jwt-assertion")


def is_direct_local(request: Request) -> bool:
    if any(name in request.headers for name in PROXY_HEADERS):
        return False
    peer = request.client.host if request.client else ""
    hostname = request.url.hostname or ""
    # TestClient is never a real TCP peer; this exception only supports isolated tests.
    if peer == "testclient":
        return hostname in {"testserver", "localhost", "127.0.0.1", "::1"}
    try:
        local_peer = ipaddress.ip_address(peer).is_loopback
        local_host = hostname == "localhost" or ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False
    return local_peer and local_host


class AuthRateLimiter:
    """Single-instance, bounded in-memory admission limit, before password hashing.

    Edge rate limits are still needed for multi-instance deployments and restarts.
    A global budget prevents spoofed/rotating IP values growing memory without bound.
    """

    def __init__(self, per_peer: int = 10, global_limit: int = 60, window: int = 60):
        self.per_peer, self.global_limit, self.window = per_peer, global_limit, window
        self._events: deque[tuple[float, str]] = deque()
        self._lock = threading.Lock()

    def allow(self, peer: str) -> bool:
        now = time.monotonic()
        with self._lock:
            while self._events and self._events[0][0] <= now - self.window:
                self._events.popleft()
            if len(self._events) >= self.global_limit or sum(key == peer for _, key in self._events) >= self.per_peer:
                return False
            self._events.append((now, peer))
            return True
