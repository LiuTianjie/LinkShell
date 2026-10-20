#!/usr/bin/env node
// Run pnpm build first. This produces a self-contained Developer ID signed app and a compact DMG used for installation and Sparkle updates.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { pruneRuntime } from './prune-runtime.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const mac = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(mac, '../..');
const config = JSON.parse(readFileSync(join(mac, 'config/desktop-release.json')));
const cliVersion = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'))).version;
const option = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const version = option('--version', cliVersion);
const build = option('--build', version);
const arch = option('--arch', process.arch);
if (!['arm64', 'x64'].includes(arch)) throw new Error('Choose --arch arm64 or --arch x64');
const machineArch = arch === 'x64' ? 'x86_64' : 'arm64';
const feedURL = config.feedURL.replace('{arch}', arch);
const out = resolve(option('--out', join(root, 'artifacts/mac', arch)));
const run = (command, args, extra = {}) => execFileSync(command, args, { stdio: 'inherit', ...extra });
const capture = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const identity = process.env.LINKSHELL_SIGN_IDENTITY || /"(Developer ID Application: [^"]+)"/.exec(capture('security', ['find-identity', '-v', '-p', 'codesigning']))?.[1];
if (!identity) throw new Error('A Developer ID Application certificate is required');
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, '.standalone-build-'));
const app = join(out, 'LinkShell.app');
const hashes = { arm64: 'dbc1a17024a32827adb23b5b11ce98cefcd783145a30fe41bb2845be711e9742', x64: '756674542a28207515cdd22ca290e53a9c1fb7b903603047278d339164eb376f' };
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function isMachO(file) {
  const header = Buffer.alloc(4), fd = openSync(file, 'r');
  try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
  return ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'));
}
function walk(path, visit) {
  for (const name of readdirSync(path)) {
    const file = join(path, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) visit(file, stat);
    else if (stat.isDirectory()) walk(file, visit);
    else visit(file, stat);
  }
}
try {
  mkdirSync(out, { recursive: true });
  if (existsSync(app)) rmSync(app, { recursive: true });
  cpSync(join(mac, 'build/LinkShell.app'), app, { recursive: true, verbatimSymlinks: true });
  for (const asset of ['index.html', 'preview/bridge.html', 'preview/worker.js']) {
    if (!existsSync(join(app, 'Contents/Resources/Workspace', asset))) throw new Error('Desktop workspace is missing; rebuild @linkshell/mac before packaging');
  }
  walk(app, (file, stat) => {
    if (stat.isSymbolicLink() || !isMachO(file)) return;
    const slices = capture('/usr/bin/lipo', ['-archs', file]).split(/\s+/);
    if (!slices.includes(machineArch)) throw new Error(`Missing ${machineArch}: ${file}`);
    if (slices.length > 1) {
      run('/usr/bin/lipo', [file, '-thin', machineArch, '-output', file + '.thin']);
      renameSync(file + '.thin', file);
    }
  });
  const workspace = join(scratch, 'workspace');
  mkdirSync(workspace);
  for (const name of ['package.json', 'pnpm-lock.yaml']) cpSync(join(root, name), join(workspace, name));
  const rootPackage = JSON.parse(readFileSync(join(workspace, 'package.json')));
  delete rootPackage.devDependencies; delete rootPackage.scripts; delete rootPackage.pnpm?.patchedDependencies;
  writeFileSync(join(workspace, 'package.json'), JSON.stringify(rootPackage));
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), `packages:\n  - packages/*\nsupportedArchitectures:\n  os: [darwin]\n  cpu: [${arch}]\nignoredOptionalDependencies:\n  - '@anthropic-ai/claude-agent-sdk-darwin-arm64'\n  - '@anthropic-ai/claude-agent-sdk-darwin-x64'\n`);
  for (const name of ['cli', 'host', 'gateway', 'wire']) {
    const source = join(root, 'packages', name), dest = join(workspace, 'packages', name);
    mkdirSync(dest, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(source, 'package.json')));
    delete pkg.scripts; delete pkg.devDependencies;
    if (pkg.optionalDependencies) delete pkg.optionalDependencies['@linkshell/mac'];
    writeFileSync(join(dest, 'package.json'), JSON.stringify(pkg, null, 2));
    for (const item of pkg.files || []) if (existsSync(join(source, item))) cpSync(join(source, item), join(dest, item), { recursive: true, verbatimSymlinks: true });
  }
  // Resolve architecture-specific production dependencies without changing the developer workspace.
  run('pnpm', ['install', '--prod', '--ignore-scripts', '--prefer-offline', '--no-frozen-lockfile'], { cwd: workspace });
  const runtime = join(app, 'Contents/Resources/runtime/cli');
  const deployed = join(scratch, 'deployed');
  run('pnpm', ['--filter', 'linkshell-cli', '--prod', 'deploy', '--legacy', '--offline', deployed], { cwd: workspace });
  cpSync(deployed, runtime, { recursive: true, verbatimSymlinks: true });
  // pnpm 10 legacy deploy leaves the self-reference pointing back into its staging workspace.
  const selfLink = join(runtime, 'node_modules/.pnpm/node_modules/linkshell-cli');
  rmSync(selfLink, { force: true }); symlinkSync('../../..', selfLink);
  pruneRuntime(runtime, arch);
  {
    const file = `node-v${config.nodeVersion}-darwin-${arch}.tar.gz`, archive = join(scratch, file);
    run('/usr/bin/curl', ['-fL', '--retry', '3', '-o', archive, `https://nodejs.org/dist/v${config.nodeVersion}/${file}`]);
    if (sha256(archive) !== hashes[arch]) throw new Error(`Node ${arch} checksum mismatch`);
    run('/usr/bin/tar', ['-xzf', archive, '-C', scratch]);
  }
  const node = join(app, 'Contents/MacOS/node');
  cpSync(join(scratch, `node-v${config.nodeVersion}-darwin-${arch}/bin/node`), node);
  chmodSync(node, 0o755);
  cpSync(join(scratch, `node-v${config.nodeVersion}-darwin-${arch}/LICENSE`), join(app, 'Contents/Resources/Node-LICENSE'));
  writeFileSync(join(app, 'Contents/Resources/standalone.json'), JSON.stringify({ version, build, cliVersion, nodeVersion: config.nodeVersion, architectures: [machineArch] }, null, 2));
  run('/usr/bin/clang', ['-O2', '-arch', machineArch, '-mmacosx-version-min=13.0', join(mac, 'scripts/standalone-launcher.c'), '-o', join(app, 'Contents/MacOS/linkshell-cli')]);
  cpSync(join(mac, 'THIRD_PARTY_NOTICES/Sparkle-LICENSE.txt'), join(app, 'Contents/Resources/Sparkle-LICENSE.txt'));
  const plist = join(app, 'Contents/Info.plist');
  const set = (key, type, value) => { try { capture('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist]); } catch {} run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist]); };
  set('CFBundleShortVersionString', 'string', version); set('CFBundleVersion', 'string', build);
  set('SUFeedURL', 'string', feedURL); set('SUPublicEDKey', 'string', config.publicEDKey);
  set('SUEnableAutomaticChecks', 'bool', 'false'); set('SUAllowsAutomaticUpdates', 'bool', 'false');
  const sign = (file, entitlements) => run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', ...(entitlements ? ['--entitlements', entitlements] : []), file]);
  walk(runtime, (file, stat) => {
    if (stat.isSymbolicLink()) {
      const target = realpathSync(file);
      if (target !== runtime && !target.startsWith(runtime + '/')) throw new Error(`Nonportable runtime symlink: ${file} -> ${readlinkSync(file)}`);
    } else {
      if (isMachO(file)) {
        chmodSync(file, stat.mode | 0o111);
        sign(file, join(mac, 'config/node-entitlements.plist'));
      }
    }
  });
  const sparkle = join(app, 'Contents/Frameworks/Sparkle.framework');
  for (const relative of ['Versions/B/XPCServices/Downloader.xpc', 'Versions/B/XPCServices/Installer.xpc', 'Versions/B/Updater.app', 'Versions/B/Autoupdate']) {
    run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', '--preserve-metadata=entitlements', join(sparkle, relative)]);
  }
  sign(sparkle); sign(join(app, 'Contents/Frameworks/WebRTC.framework'));
  sign(node, join(mac, 'config/node-entitlements.plist'));
  sign(join(app, 'Contents/MacOS/linkshell-cli'));
  sign(app);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '--verbose=2', app]);
  const profile = process.env.LINKSHELL_NOTARY_PROFILE;
  const zip = join(scratch, `LinkShell-${version}-${arch}-notarize.zip`);
  const zipApp = () => { rmSync(zip, { force: true }); run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]); };
  if (profile) { zipApp(); run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--wait']); run('xcrun', ['stapler', 'staple', app]); }
  const volume = join(scratch, 'volume'); mkdirSync(volume);
  run('/usr/bin/ditto', [app, join(volume, 'LinkShell.app')]);
  run('/bin/ln', ['-s', '/Applications', join(volume, 'Applications')]);
  writeFileSync(join(volume, '安装说明.txt'), '将 LinkShell.app 拖入 Applications，然后打开。\n已内置 Node、CLI 和 Host，无需安装 npm。\nApp 设置中可选安装终端命令。\n');
  const dmg = join(out, `LinkShell-${version}-${arch}.dmg`); rmSync(dmg, { force: true });
  const intermediate = join(scratch, 'volume.dmg');
  run('/usr/bin/hdiutil', ['create', '-volname', 'LinkShell', '-srcfolder', volume, '-ov', '-format', 'UDZO', intermediate]);
  // Conversion drops the unused compressed extents left by srcfolder creation.
  run('/usr/bin/hdiutil', ['convert', intermediate, '-format', 'ULMO', '-o', dmg]); sign(dmg);
  if (profile) { run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait']); run('xcrun', ['stapler', 'staple', dmg]); }
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version, build, cliVersion, nodeVersion: config.nodeVersion, architecture: arch, feedURL, notarized: !!profile, artifacts: [dmg].map((file) => ({ name: file.split('/').at(-1), sha256: sha256(file) })) }, null, 2));
  console.log(`Standalone artifacts: ${out}${profile ? '' : ' (signed, NOT notarized)'}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
