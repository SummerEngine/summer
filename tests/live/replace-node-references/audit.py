"""On-demand V4 replacement regression in an owned disposable editor/project."""
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

from verify import verify


def run(editor: Path, package: Path, output: Path):
    source = Path(__file__).resolve().parent
    output.mkdir(parents=True, exist_ok=False)
    token = ''
    process = None
    with tempfile.TemporaryDirectory(prefix='summer-replace-references-') as temporary:
        private = Path(temporary).resolve()
        project, state, home = (private / name for name in ['project', 'state', 'home'])
        shutil.copytree(source / 'fixtures', project)
        state.mkdir()
        home.mkdir()
        environment = {
            'PATH': os.environ['PATH'], 'HOME': str(home), 'TMPDIR': str(private),
            'LANG': 'en_US.UTF-8', 'SUMMER_WEBVIEW_EPHEMERAL': '1',
            'SUMMER_NO_TELEMETRY': '1', 'DO_NOT_TRACK': '1', 'SUMMER_HEADLESS_ROUTING': '0',
        }
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        try:
            with (private / 'editor.log').open('wb') as log:
                process = subprocess.Popen([
                    str(editor), '--headless', '--editor', '--path', str(project),
                    '--summer-isolated-editor', '--summer-no-publish', '--summer-api-port', str(port),
                    '--summer-api-state-dir', str(state), '--audio-driver', 'Dummy', '--max-fps', '30',
                    'res://main.tscn',
                ], env=environment, stdout=log, stderr=log, stdin=subprocess.DEVNULL)
                for _ in range(400):
                    registrations = list(state.rglob('instances/*.json'))
                    if registrations:
                        break
                    if process.poll() is not None:
                        raise RuntimeError('Owned editor exited before registration')
                    time.sleep(0.1)
                else:
                    raise RuntimeError('Owned editor registration timeout')
                instance = json.loads(registrations[0].read_text())
                token = instance['token']
                assert instance['pid'] == process.pid and instance['port'] == port
                assert Path(instance['resourceRoot']).resolve() == project
                registry = state / 'instances'
                registry.mkdir(exist_ok=True)
                (registry / registrations[0].name).write_text(json.dumps(instance))
                connection = dict(instance, project=str(project), summerDir=str(state),
                                  destination=str(output), toolkitRoot=str(package))
                sdk = subprocess.run(['node', str(source / 'probe.mjs')], input=json.dumps(connection),
                                     env=environment, cwd=project, text=True, capture_output=True, timeout=180)
                scrub = lambda text: text.replace(token, '[REDACTED_TOKEN]').replace(str(private), '<PRIVATE_ROOT>')
                (output / 'probe.log').write_text(scrub(sdk.stdout + '\n' + sdk.stderr))
                if sdk.returncode:
                    raise RuntimeError('SDK probe failed; see probe.log')
                manifest = json.loads((output / 'receipts.json').read_text())['snapshots']
                (project / 'audit-manifest.json').write_text(json.dumps(manifest))
                shutil.copy2(source / 'inspect.gd', project / 'inspect.gd')
                inspected = subprocess.run([
                    str(editor), '--headless', '--path', str(project), '--summer-no-api',
                    '--summer-no-publish', '--audio-driver', 'Dummy', '--script', 'res://inspect.gd',
                ], env=environment, cwd=project, text=True, capture_output=True, timeout=40)
                (output / 'inspector.log').write_text(scrub(inspected.stdout + '\n' + inspected.stderr))
                if inspected.returncode:
                    raise RuntimeError('Independent fresh Godot reload failed; see inspector.log')
                shutil.copy2(project / 'fresh-graphs.json', output / 'fresh-graphs.json')
                shutil.copytree(project, output / 'project', ignore=shutil.ignore_patterns('.godot', '*.uid'))
                verify(output)
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            log = (private / 'editor.log').read_text(errors='replace')
            (output / 'editor.log').write_text(log.replace(token, '[REDACTED_TOKEN]') if token else log)
            (output / 'lifecycle.json').write_text(json.dumps({
                'editor_stopped': process.poll() is not None if process else True,
                'native_sha256': hashlib.sha256(editor.read_bytes()).hexdigest(),
                'native_version': subprocess.check_output([str(editor), '--version'], text=True).strip(),
                'package': str(package), 'project_state_home': 'disposable private roots',
                'transport': 'SDK fetch limited to owned loopback port; SDK subprocesses forbidden',
            }, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--editor', type=Path, required=True)
    parser.add_argument('--package', type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument('--output', type=Path, required=True, help='A new output directory')
    args = parser.parse_args()
    run(args.editor.resolve(), args.package.resolve(), args.output.resolve())
