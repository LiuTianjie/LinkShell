#!/usr/bin/env python3
"""Rebuild the checked-in portable Ghostty core; not run by npm consumers."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'manifest.json').read_text())
zig = os.environ.get('ZIG', 'zig')
if subprocess.check_output([zig, 'version'], text=True).strip() != manifest['zig']:
    raise SystemExit('Set ZIG to the pinned Zig ' + manifest['zig'] + ' executable')
with tempfile.TemporaryDirectory(prefix='linkshell-terminal-core-') as scratch:
    work = Path(scratch)
    archive = work / 'ghostty.tar.gz'
    if os.environ.get('GHOSTTY_ARCHIVE'):
        shutil.copyfile(os.environ['GHOSTTY_ARCHIVE'], archive)
    else:
        subprocess.run(['curl', '-fL', '--retry', '3', manifest['source'], '-o', str(archive)], check=True)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['sourceSha256']:
        raise SystemExit('Ghostty source archive checksum mismatch')
    (work / 'ghostty').mkdir()
    subprocess.run(['tar', '-xzf', str(archive), '--strip-components=1', '-C', str(work / 'ghostty')], check=True)
    subprocess.run(['patch', '-p1', '-i', str(root / 'ghostty-wasm.patch')], cwd=work / 'ghostty', check=True)
    for name in ['main.zig', 'build.zig', 'build.zig.zon']:
        shutil.copyfile(root / name, work / name)
    env = os.environ.copy()
    # New macOS SDKs can omit Zig 0.15's arm64 libSystem stub. Opt into an
    # installed compatible SDK without modifying the global Xcode selection.
    if env.get('GHOSTTY_MACOS_SDK'):
        sdk = str(Path(env['GHOSTTY_MACOS_SDK']).resolve())
        (work / 'tools').mkdir()
        shim = work / 'tools' / 'xcrun'
        import shlex
        shim.write_text('#!/bin/sh\nif [ "$*" = "--sdk macosx --show-sdk-path" ]; then\n  printf "%s\\n" ' + shlex.quote(sdk) + '\nelse\n  exec /usr/bin/xcrun "$@"\nfi\n')
        shim.chmod(0o755)
        env['PATH'] = str(shim.parent) + os.pathsep + env['PATH']
    subprocess.run([zig, 'build'], cwd=work, env=env, check=True)
    artifact = gzip.compress((work / 'zig-out/bin/terminal-state.wasm').read_bytes(), mtime=0)
    (root.parent.parent / 'src/terminal-state.wasm.gz').write_bytes(artifact)
    manifest['artifactSha256'] = hashlib.sha256(artifact).hexdigest()
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('terminal-state.wasm.gz:', len(artifact), 'bytes;', manifest['artifactSha256'])
