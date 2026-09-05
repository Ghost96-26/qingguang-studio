"""Check current source snapshot or Git index. Does not certify old Git history."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess

BLOCKED = {'runtime', 'node_modules', '.venv', 'models', 'data', 'artifacts', 'logs', 'research', 'output', 'vendor', '.cache', 'dist', '__pycache__', 'release'}
BINARY = {'.safetensors', '.gguf', '.pth', '.pt', '.ckpt', '.onnx', '.bin', '.exe', '.dll', '.zip', '.7z', '.mp4', '.wav', '.png', '.jpg', '.sqlite3', '.db', '.pyc', '.pdf'}
PATTERNS = [
    re.compile(r'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----'),
    re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|hf_[A-Za-z0-9]{25,}|sk-[A-Za-z0-9_-]{24,})\b'),
    re.compile(r'https?://[^\s/:]+:[^\s/@]+@'),
    re.compile(r'(?i)["\'](?:api_key|access_token|refresh_token|client_secret|password)["\']\s*:\s*["\'][^"\'\s]{20,}["\']'),
    re.compile(r'(?i)C:[\\/]+Users[\\/]+(?!PUBLIC_USER\b|Public\b)[^\\/\s"\']+'),
]


SHOWCASE = {
    "docs/public/assets/asset-library.png": "6079037d20af6e4dbb1d03c53b5e34275e1f5489e64d159453ac4869753422ea",
    "docs/public/assets/director-demo.mp4": "c30bed601d0f8a03c2e7a6a742d2acb7d59a8498b8a2687163053188f6228805",
    "docs/public/assets/director-panel.png": "dff1440e5da209dc09827e36032689c66f53c005fb6cce3ca59eeb11d9b4b399",
    "docs/public/assets/director-poster.png": "4d5b30b7c15b7fdd280ef81a1f8042d4bd2048008c03f0ebb837d387e2af3944",
    "docs/public/assets/hero.svg": "9a5c6fcd3e0ed9d0f0990888d2b35a50acaa2701dbe1dafed47e0ed0874c6e2f",
    "docs/public/assets/model-panel.png": "bceb072ecfb31aa9542ee79df913773a070e479268dff8f7f5e71ee737a35ba3"
}


def inspect_files(files):
    issues = []
    for name, data in files.items():
        path = Path(name)
        if name in SHOWCASE:
            if hashlib.sha256(data).hexdigest() != SHOWCASE[name]:
                issues.append(f'Showcase file needs renewed review: {name}')
            if len(data) > 2 * 1024 * 1024:
                issues.append(f'Showcase file exceeds 2 MiB: {name}')
            continue
        if any(p.lower() in BLOCKED for p in path.parts) or path.suffix.lower() in BINARY or 'secrets' in path.name.lower() or '.accepted.' in path.name or path.name == '.env':
            # The secret initializer contains no secret; it is explicitly allowed.
            if path.name != 'Initialize-GatewaySecrets.ps1':
                issues.append(f'Excluded file: {name}')
        if len(data) > 2 * 1024 * 1024:
            issues.append(f'File exceeds 2 MiB: {name}')
        try:
            content = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            issues.append(f'Non-text file: {name}')
            continue
        # One audited, synthetic HTTP-test credential; no blanket test exemption.
        if name == 'services/orchestrator/tests/test_account_http.py':
            fixture = 'test-only' + '-long-password'
            content = content.replace(f'"password": "{fixture}"', '"password": "TEST"')
        if any(pattern.search(content) for pattern in PATTERNS):
            issues.append(f'Sensitive pattern (value hidden): {name}')
    if sum(map(len, files.values())) > 20 * 1024 * 1024:
        issues.append('Source snapshot exceeds 20 MiB budget')
    return issues


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--staged', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    if args.staged:
        names = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).decode().split('\0')
        files = {n: subprocess.check_output(['git', '-C', str(root), 'show', ':' + n]) for n in names if n}
    else:
        files = {}
        for base, dirs, names in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if d not in {'.git', '__pycache__'}]
            if any((Path(base) / d).is_symlink() or (Path(base) / d).is_junction() for d in dirs):
                raise SystemExit('Directory links are not allowed in public snapshot')
            for name in names:
                path = Path(base) / name
                if path.is_symlink() or path.is_junction():
                    raise SystemExit('Links are not allowed in public snapshot')
                if path.stat().st_size > 2 * 1024 * 1024:
                    raise SystemExit(f'File exceeds 2 MiB: {path.relative_to(root)}')
                files[path.relative_to(root).as_posix()] = path.read_bytes()
    issues = inspect_files(files)
    if issues:
        raise SystemExit('\n'.join(issues))
    print(f'PASS: {len(files)} source/showcase files, {sum(map(len, files.values())) / 1024 / 1024:.2f} MiB. History not scanned.')


if __name__ == '__main__':
    main()
