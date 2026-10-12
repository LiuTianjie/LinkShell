#!/usr/bin/env python3
"""Check Metal submission during a main-thread stall in an owned, disposable simulator.

python3 tools/renderer-check.py [--reference <git-commit>] [--json <result>]
Requires Xcode, an installed iOS 17+ simulator runtime and the client's installed WebRTC pod.
This measures GPU submissions, not phone presentation latency or end-to-end screen latency.
"""

import argparse
import json
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference")
    parser.add_argument("--connection", action="store_true", help="Check native timeout fallback with and without RTC config instead of renderer cadence")
    parser.add_argument("--json", type=Path)
    options = parser.parse_args()
    if options.connection and options.reference:
        parser.error("--connection and --reference cannot be combined")
    module = Path(__file__).resolve().parents[1]
    repo = module.parents[3]
    source = module / "ios"
    frameworks = [module.parents[1] / f"ios/Pods/{pod}/WebRTC.xcframework/ios-arm64_x86_64-simulator" for pod in ("WebRTC-lib", "JitsiWebRTC")]
    framework = next((path for path in frameworks if path.is_dir()), None)
    if framework is None:
        raise RuntimeError("The client's simulator WebRTC pod is missing; install its native dependencies first.")
    sdk = run("xcrun", "--sdk", "iphonesimulator", "--show-sdk-path")
    arch = run("uname", "-m")
    runtimes = json.loads(run("xcrun", "simctl", "list", "runtimes", "-j"))["runtimes"]
    available = [r for r in runtimes if r["isAvailable"] and r["name"].startswith("iOS ")
                 and int(r["version"].split(".")[0]) >= 17 and arch in r.get("supportedArchitectures", [])]
    if not available:
        raise RuntimeError("An installed iOS 17+ simulator runtime matching this Mac is required.")
    runtime = max(available, key=lambda r: tuple(map(int, r["version"].split("."))))
    device = next(d for d in runtime["supportedDeviceTypes"] if d["productFamily"] == "iPhone")
    results = {"runtime": runtime["version"], "device": device["name"], "blockedSeconds": 0.6, "runs": {}}
    with tempfile.TemporaryDirectory(prefix="linkshell-render-check-") as temporary:
        work = Path(temporary)
        variants = [("worker", source / "ScreenMetalView.swift")]
        if options.reference:
            if options.reference.startswith("-"):
                raise ValueError("Invalid reference")
            reference = run("git", "rev-parse", "--verify", options.reference + "^{commit}", cwd=repo)
            baseline = run("git", "show", reference + ":apps/client/modules/link-screen/ios/ScreenMetalView.swift", cwd=repo)
            if "metrics.committed()" not in baseline:
                baseline = baseline.replace("    command.commit()", "    command.commit()\n    metrics.committed()")
            reference_file = work / "Baseline.swift"
            reference_file.write_text(baseline)
            variants.insert(0, ("reference", reference_file))
            results["reference"] = reference
        apps = []
        for name, metal in variants:
            app = work / (name + ".app")
            app.mkdir()
            bundle = "tech.itool.linkshell.rendercheck." + name
            info = {"CFBundleIdentifier": bundle, "CFBundleName": "Render Check " + name,
                    "CFBundleExecutable": "RenderCheck", "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0",
                    "CFBundlePackageType": "APPL", "CFBundleSupportedPlatforms": ["iPhoneSimulator"], "UIDeviceFamily": [1, 2],
                    "MinimumOSVersion": "16.4", "UIApplicationSceneManifest": {"UIApplicationSupportsMultipleScenes": False},
                    "UILaunchScreen": {}, "CADisableMinimumFrameDurationOnPhone": True}
            (app / "Info.plist").write_bytes(plistlib.dumps(info))
            files = [*sorted((source / "Core").glob("*.swift")), source / "ScreenMetrics.swift", metal,
                     module / "tools/fixtures/RendererAudit.swift"]
            if options.connection:
                files[-1:] = [source / "HEVCDecoder.swift", source / "ScreenDecoder.swift", source / "ScreenConnection.swift", module / "tools/fixtures/ConnectionAudit.swift"]
            run("xcrun", "--sdk", "iphonesimulator", "swiftc", "-swift-version", "5", "-target", arch + "-apple-ios16.4-simulator",
                "-sdk", sdk, "-F", str(framework), "-framework", "WebRTC", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/Frameworks",
                *map(str, files), "-o", str(app / "RenderCheck"))
            shutil.copytree(framework / "WebRTC.framework", app / "Frameworks/WebRTC.framework", symlinks=True)
            run("codesign", "--force", "--sign", "-", str(app / "Frameworks/WebRTC.framework"))
            run("codesign", "--force", "--sign", "-", str(app))
            apps.append((name, app, bundle))
        owned = run("xcrun", "simctl", "create", "LinkShell Render Check " + work.name, device["identifier"], runtime["identifier"])
        try:
            run("xcrun", "simctl", "boot", owned)
            run("xcrun", "simctl", "bootstatus", owned, "-b", timeout=180)
            for name, app, bundle in apps:
                run("xcrun", "simctl", "install", owned, str(app))
                container = Path(run("xcrun", "simctl", "get_app_container", owned, bundle, "data"))
                result = container / "Documents/result.json"
                run("xcrun", "simctl", "launch", "--terminate-running-process", owned, bundle)
                until = time.monotonic() + (40 if options.connection else 25)
                while not result.exists() and time.monotonic() < until:
                    time.sleep(0.1)
                if not result.exists():
                    raise RuntimeError(name + " did not finish the rendering check")
                data = json.loads(result.read_text())
                if options.connection:
                    results["runs"]["connection"] = data
                    assert data["passed"], "Native timeout fallback failed: " + json.dumps(data)
                    run("xcrun", "simctl", "terminate", owned, bundle)
                    continue
                blocked = [r["gpuSubmissions"] for r in data["rows"] if r["blocked"] and 2.1 < r["second"] < 2.55]
                steady = [r["gpuSubmissions"] for r in data["rows"] if 1 < r["second"] < 1.9]
                resumed = [r["gpuSubmissions"] for r in data["rows"] if 5.5 < r["second"] < 6.9]
                results["runs"][name] = {"blockedCommits": blocked, "steadyCommits": steady, "resumedCommits": resumed, "failures": data["failures"]}
                assert not data["failures"] and sum(steady) > 0 and sum(resumed) > 0, name + " did not render/restart normally"
                if name == "worker":
                    assert blocked and sum(blocked) > 0, "Rendering stopped with the main thread"
                run("xcrun", "simctl", "terminate", owned, bundle)
        finally:
            # Only the UUID just returned by our create call is ever shut down or deleted.
            subprocess.run(["xcrun", "simctl", "shutdown", owned], capture_output=True)
            run("xcrun", "simctl", "delete", owned)
    print(json.dumps(results, indent=2))
    if options.json:
        options.json.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.stderr.write(error.stderr or str(error))
        raise SystemExit(error.returncode)
