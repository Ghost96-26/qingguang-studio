"""Export an explicit source allowlist, redact machine paths, then enforce budgets.

Run from the private workspace. A new destination is mandatory. No network or Git
operations are performed. Never print matching secrets in findings.
"""
import argparse
from datetime import date
import hashlib
import json
import os
import re
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
SUFFIXES = {'.py', '.ps1', '.cmd', '.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.json', '.txt'}
SKIP = {'node_modules', 'dist', '__pycache__', '.git', '.openai', 'design-reference'}
SCRIPT_NAMES = {
    'Common-H3Runtime.ps1', 'Install-H3Runtime.ps1', 'Start-H3Runtime.ps1',
    'Stop-H3Runtime.ps1', 'Restart-H3Runtime.ps1', 'Start-WorkbenchGateway.ps1',
    'Stop-WorkbenchGateway.ps1', 'Initialize-GatewaySecrets.ps1', 'Open-H3Workbench.ps1',
    'Open-AdminConsole.ps1',
    'Test-H3Runtime.ps1', 'Test-Workbench.ps1', 'Run-H3SmokeTest.ps1',
    'Common-ImageModelDownload.ps1', 'Download-ImageModels-CN-BF16.ps1',
    'Download-ImageModels-HF-VPN.ps1', 'Common-HunyuanVideoFoleyDownload.ps1',
    'Download-HunyuanVideoFoley-XXL-CN.ps1', 'Download-HunyuanVideoFoley-XXL-HF-VPN.ps1',
    'initialize_public_config.py', 'export_public_repository.py', 'check_public_repository.py',
}


def sanitize(text):
    # Machine-specific source/model roots are discovered only from private config.
    runtime = json.loads((SOURCE / 'config/runtime.json').read_text(encoding='utf-8-sig'))
    mapping = {runtime['project_root']: r'C:\QingguangStudio', runtime['model_root']: r'C:\QingguangModels'}
    gateway = json.loads((SOURCE / 'config/gateway.json').read_text(encoding='utf-8-sig'))
    mapping[gateway['ffmpeg_executable']] = 'ffmpeg'
    for old, new in sorted(mapping.items(), key=lambda pair: -len(pair[0])):
        for a, b in [(old.replace('\\', '\\\\'), new.replace('\\', '\\\\')), (old.replace('\\', '/'), new.replace('\\', '/')), (old, new)]:
            text = text.replace(a, b)
    # Catch user paths outside the project without carrying the owner's name.
    text = re.sub(r'(?i)C:[\\/]+Users[\\/]+[^\\/\s"\']+', lambda _: r'C:\Users\PUBLIC_USER', text)
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    dest = args.destination.resolve()
    if dest.exists():
        raise SystemExit('Destination must not exist; use a fresh release directory.')
    selected = set()
    for folder in ('services/ui', 'services/ui-v3', 'services/orchestrator', 'services/adapters', 'services/shared', 'tools'):
        for base, dirs, files in os.walk(SOURCE / folder, followlinks=False):
            dirs[:] = [d for d in dirs if d not in SKIP and not (Path(base) / d).is_symlink() and not (Path(base) / d).is_junction()]
            for name in files:
                path = Path(base) / name
                if path.suffix in SUFFIXES and not path.is_symlink():
                    selected.add(path.relative_to(SOURCE))
    selected.update(Path('scripts') / name for name in SCRIPT_NAMES)
    selected.update(p.relative_to(SOURCE) for p in SOURCE.glob('[0-9][0-9]_*.cmd'))
    selected.update(Path(name) for name in ('01_MiniMax_H3_CN_Download.ps1', '02_MiniMax_H3_HF_VPN_Download.ps1', '.gitignore', 'config/model-registry.json', 'config/runtime-packages.txt', 'config/indextts-py312-requirements.txt', 'services/ui-v3/.openai/hosting.json'))
    selected.add(Path('docs/local-admin-console.md'))
    selected.update(p.relative_to(SOURCE) for p in (SOURCE / 'config/templates').glob('*.json'))
    selected.update(p.relative_to(SOURCE) for p in (SOURCE / 'docs/public').glob('*.md'))
    selected.update(p.relative_to(SOURCE) for p in (SOURCE / 'deploy/reference').glob('*') if p.is_file())
    contents = {p: sanitize((SOURCE / p).read_text(encoding='utf-8-sig')) for p in sorted(selected)}
    homepage = re.sub(r'\]\(([^/()]+\.md)\)', r'](docs/public/\1)', contents[Path('docs/public/README.md')])
    contents[Path('README.md')] = homepage.replace('](assets/', '](docs/public/assets/').replace('src="assets/', 'src="docs/public/assets/')
    contents[Path('AGENTS.md')] = contents[Path('docs/public/AGENT-DEPLOYMENT.md')]
    # Exact secret-value comparison, without leaking values or lines into reports.
    secrets_path = SOURCE / 'config/gateway-secrets.json'
    def strings(value):
        if isinstance(value, dict):
            for item in value.values(): yield from strings(item)
        elif isinstance(value, list):
            for item in value: yield from strings(item)
        elif isinstance(value, str) and len(value) >= 20:
            yield value
    known = list(strings(json.loads(secrets_path.read_text(encoding='utf-8-sig')))) if secrets_path.exists() else []
    for path, content in contents.items():
        if any(secret in content for secret in known):
            raise SystemExit(f'Private value detected in {path}; export aborted.')
    from check_public_repository import inspect_files, SHOWCASE
    encoded = {p.as_posix(): s.encode('utf-8') for p, s in contents.items()}
    for relative in SHOWCASE:
        encoded[relative] = (SOURCE / relative).read_bytes()
    issues = inspect_files(encoded)
    if issues:
        raise SystemExit('\n'.join(issues))
    dest.mkdir(parents=True)
    for path, data in encoded.items():
        target = dest / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    report = {'date': date.today().isoformat(), 'files': len(encoded), 'bytes': sum(map(len, encoded.values())), 'findings': [], 'scope': 'allowlisted source plus SHA256-reviewed showcase; exact local secret comparison and pattern scan', 'inventory': [{'path': p, 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()} for p, b in sorted(encoded.items())]}
    with (dest / 'PUBLIC-EXPORT-REPORT.json').open('w', encoding='utf-8', newline='\n') as handle:
        handle.write(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'destination': str(dest), 'files': report['files'], 'bytes_before_report': report['bytes'], 'findings': 0}))


if __name__ == '__main__':
    main()
