"""Create private machine config from portable templates; never overwrite files."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--model-root', type=Path, required=True)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    args = parser.parse_args()
    root = args.project_root.resolve()
    model = args.model_root.resolve()
    templates = Path(__file__).resolve().parents[1] / 'config' / 'templates'
    mapping = {'${PROJECT_ROOT}': str(root), '${MODEL_ROOT}': str(model), '${FFMPEG}': args.ffmpeg}

    def expand(value):
        if isinstance(value, dict):
            return {k: expand(v) for k, v in value.items()}
        if isinstance(value, list):
            return [expand(v) for v in value]
        if isinstance(value, str):
            for key, replacement in mapping.items():
                value = value.replace(key, replacement)
        return value

    outputs = {}
    for name in ('runtime', 'gateway'):
        payload = expand(json.loads((templates / f'{name}.example.json').read_text(encoding='utf-8-sig')))
        outputs[root / 'config' / f'{name}.json'] = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
    # JSON-quoted forward-slash paths are also valid YAML strings.
    paths = []
    for key, suffix in [('minimax_h3_local', 'video/minimax-h3'), ('krea2_bf16_local', 'image/krea2'), ('ideogram4_local', 'image/ideogram4')]:
        paths.append(f'{key}:\n  base_path: {json.dumps((model / suffix).as_posix())}\n  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  vae: vae\n  loras: loras\n')
    outputs[root / 'config' / 'extra_model_paths.yaml'] = '\n'.join(paths)
    outputs[root / 'config' / 'model-root.txt'] = str(model) + '\n'
    collisions = [p.name for p in outputs if p.exists()]
    if collisions:
        raise SystemExit('Refusing to overwrite existing config: ' + ', '.join(collisions))
    for directory in ('config', 'logs', 'data', 'artifacts', 'manifests', 'runtime'):
        (root / directory).mkdir(parents=True, exist_ok=True)
    for path, content in outputs.items():
        with path.open('x', encoding='utf-8') as stream:
            stream.write(content)
    print('Created local configuration. No models downloaded; no secrets or readiness markers copied.')


if __name__ == '__main__':
    main()
