from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG = PROJECT_ROOT / "config" / "gateway.json"


@dataclass(frozen=True)
class Settings:
    raw: dict[str, Any]

    @classmethod
    def load(cls) -> "Settings":
        path = Path(os.environ.get("H3_WORKBENCH_CONFIG", DEFAULT_CONFIG))
        return cls(json.loads(path.read_text(encoding="utf-8-sig")))

    def path(self, key: str) -> Path:
        return Path(self.raw[key])

    @property
    def api_key(self) -> str:
        secret_path = self.path("api_key_file")
        payload = json.loads(secret_path.read_text(encoding="utf-8-sig"))
        key = str(payload.get("api_key", "")).strip()
        if len(key) < 32:
            raise RuntimeError(f"Gateway API key is missing or too short: {secret_path}")
        return key

    @property
    def public_edge_secret(self) -> str:
        secret_path = self.path("api_key_file")
        payload = json.loads(secret_path.read_text(encoding="utf-8-sig"))
        return str(payload.get("public_edge_secret", "")).strip()

    @property
    def base_url(self) -> str:
        return f"http://{self.raw['listen']}:{self.raw['port']}"
