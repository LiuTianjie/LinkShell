#!/usr/bin/env python3
"""Verify distributable tarballs without installing or publishing anything."""
import json
import sys
import tarfile
from pathlib import Path

paths = sorted(Path(sys.argv[1]).glob("*.tgz"))
expected = {"@linkshell/wire", "@linkshell/host", "@linkshell/gateway", "linkshell-cli"}
packages = {}
for path in paths:
    with tarfile.open(path) as archive:
        manifest = json.load(archive.extractfile("package/package.json"))
        assert "workspace:" not in json.dumps(manifest), f"workspace dependency leaked: {path}"
        assert not any(name.startswith("package/web/") for name in archive.getnames()), f"legacy console: {path}"
        entries = [manifest["main"]] if manifest.get("main") else []
        bins = manifest.get("bin", {})
        entries.extend(bins.values() if isinstance(bins, dict) else [bins])
        for entry in entries:
            assert "package/" + entry.removeprefix("./") in archive.getnames(), f"missing package entry: {path}: {entry}"
        packages[manifest["name"]] = manifest
if "@linkshell/mac" in packages:
    expected.add("@linkshell/mac")
assert set(packages) == expected, f"expected {expected}, got {set(packages)}"
for name, manifest in packages.items():
    for dependency, version in {**manifest.get("dependencies", {}), **manifest.get("optionalDependencies", {})}.items():
        if dependency in packages:
            assert version == packages[dependency]["version"], f"mismatched {name} -> {dependency}: {version}"
    print(f"OK {name}@{manifest['version']}")
