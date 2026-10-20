import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Only the SDK loader is bundled. Evergreen Runtime receives Microsoft's security updates.
export const webview2 = {
  version: '1.0.4258.31',
  sha256: '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9',
};
export const webview2Files = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Wpf.dll', 'WebView2Loader.dll', 'WEBVIEW2-LICENSE.txt', 'WEBVIEW2-NOTICE.txt'];
export async function ensureWebView2() {
  const build = resolve(dirname(fileURLToPath(import.meta.url)), '../build');
  const cache = join(build, 'webview2-sdk');
  mkdirSync(cache, { recursive: true });
  const zip = join(cache, 'sdk.zip');
  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${webview2.version}/microsoft.web.webview2.${webview2.version}.nupkg`;
  if (!existsSync(zip)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`WebView2 SDK download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== webview2.sha256) throw new Error('WebView2 SDK checksum mismatch');
    writeFileSync(zip, bytes);
  }
  if (createHash('sha256').update(readFileSync(zip)).digest('hex') !== webview2.sha256) throw new Error('Cached WebView2 SDK checksum mismatch');
  const unpack = spawnSync('tar.exe', ['-xf', zip, '-C', cache], { windowsHide: true, stdio: 'inherit' });
  if (unpack.error || unpack.status) throw unpack.error ?? new Error('Cannot extract WebView2 SDK');
  for (const name of webview2Files.slice(0, 2)) cpSync(join(cache, 'lib/net462', name), join(build, name));
  cpSync(join(cache, 'runtimes/win-x64/native/WebView2Loader.dll'), join(build, 'WebView2Loader.dll'));
  cpSync(join(cache, 'LICENSE.txt'), join(build, 'WEBVIEW2-LICENSE.txt'));
  writeFileSync(join(build, 'WEBVIEW2-NOTICE.txt'), `Microsoft WebView2 SDK ${webview2.version}\n${url}\nSHA256: ${webview2.sha256}\nRequires Microsoft Edge WebView2 Evergreen Runtime: https://go.microsoft.com/fwlink/p/?LinkId=2124703\n`);
  return webview2Files.slice(0, 2).map(name => `/r:${join(build, name)}`);
}
