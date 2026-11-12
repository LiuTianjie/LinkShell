import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';

const DEFAULT_ACS_TIMESTAMP = 'http://timestamp.acs.microsoft.com';
const DEFAULT_PFX_TIMESTAMP = 'http://timestamp.digicert.com';

export function findSigntool(env = process.env) {
  if (env.SIGNTOOL_PATH?.trim()) return env.SIGNTOOL_PATH.trim();
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const kitsBin = join(programFilesX86, 'Windows Kits', '10', 'bin');
  if (existsSync(kitsBin)) {
    const versions = readdirSync(kitsBin)
      .filter((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(kitsBin, version, 'x64', 'signtool.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'signtool.exe';
}

export function resolveSigningConfig(env = process.env) {
  const endpoint = env.AZURE_TRUSTED_SIGNING_ENDPOINT?.trim();
  const account = env.AZURE_TRUSTED_SIGNING_ACCOUNT?.trim();
  const profile = env.AZURE_TRUSTED_SIGNING_PROFILE?.trim();
  const dlib = env.AZURE_TRUSTED_SIGNING_DLIB?.trim();

  if (endpoint || account || profile) {
    const missing = [
      !endpoint && 'AZURE_TRUSTED_SIGNING_ENDPOINT',
      !account && 'AZURE_TRUSTED_SIGNING_ACCOUNT',
      !profile && 'AZURE_TRUSTED_SIGNING_PROFILE',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Incomplete Azure Trusted Signing configuration; missing: ${missing.join(', ')}`);
    }
    return {
      mode: 'azure-trusted-signing',
      endpoint,
      account,
      profile,
      dlib: dlib || undefined,
      timestampUrl: env.WINDOWS_TIMESTAMP_URL?.trim() || DEFAULT_ACS_TIMESTAMP,
    };
  }

  const pfxPath = env.WINDOWS_PFX_PATH?.trim();
  const pfxBase64 = env.WINDOWS_PFX_BASE64?.trim();
  if (pfxPath || pfxBase64) {
    return {
      mode: 'pfx',
      pfxPath: pfxPath || undefined,
      pfxBase64: pfxPath ? undefined : pfxBase64,
      password: env.WINDOWS_PFX_PASSWORD ?? '',
      timestampUrl: env.WINDOWS_TIMESTAMP_URL?.trim() || DEFAULT_PFX_TIMESTAMP,
    };
  }

  return { mode: 'skipped' };
}

export function signWindowsBinaries(files, options = {}) {
  const env = options.env ?? process.env;
  const run = options.execFile ?? execFileSync;
  const log = options.log ?? ((message) => console.log(message));
  const targets = files.map((file) => resolve(file));

  if (targets.length === 0) {
    return { signed: false, mode: 'skipped', files: [] };
  }
  for (const target of targets) {
    if (!existsSync(target)) {
      throw new Error(`Cannot sign missing Windows binary: ${target}`);
    }
  }

  const config = resolveSigningConfig(env);
  if (config.mode === 'skipped') {
    log(`[sign] Skipping Authenticode signing for ${targets.length} file(s) (set AZURE_TRUSTED_SIGNING_* or WINDOWS_PFX_* to sign).`);
    return { signed: false, mode: 'skipped', files: targets };
  }

  if (config.mode === 'azure-trusted-signing') {
    if (config.dlib) {
      const scratch = mkdtempSync(join(tmpdir(), 'linkshell-acs-'));
      try {
        const metadataPath = join(scratch, 'metadata.json');
        writeFileSync(metadataPath, JSON.stringify({
          Endpoint: config.endpoint,
          CodeSigningAccountName: config.account,
          CertificateProfileName: config.profile,
        }, null, 2));
        const signtool = (options.findSigntool ?? findSigntool)(env);
        log(`[sign] Signing ${targets.length} file(s) with Azure Trusted Signing dlib (${config.account}/${config.profile})`);
        run(signtool, [
          'sign',
          '/fd', 'SHA256',
          '/tr', config.timestampUrl,
          '/td', 'SHA256',
          '/dlib', config.dlib,
          '/dmdf', metadataPath,
          ...targets,
        ], { windowsHide: true, stdio: 'inherit', env });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      return { signed: true, mode: config.mode, method: 'signtool-dlib', files: targets };
    }

    log(`[sign] Signing ${targets.length} file(s) with Invoke-TrustedSigning (${config.account}/${config.profile})`);
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      '$files = $env:LINKSHELL_SIGN_FILES -split [IO.Path]::PathSeparator | Where-Object { $_ }',
      'Invoke-TrustedSigning `',
      '  -Endpoint $env:AZURE_TRUSTED_SIGNING_ENDPOINT `',
      '  -CodeSigningAccountName $env:AZURE_TRUSTED_SIGNING_ACCOUNT `',
      '  -CertificateProfileName $env:AZURE_TRUSTED_SIGNING_PROFILE `',
      "  -FileDigest 'SHA256' `",
      '  -TimestampRfc3161 $env:LINKSHELL_SIGN_TIMESTAMP `',
      "  -TimestampDigest 'SHA256' `",
      '  -Files $files',
    ].join('\n');
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      windowsHide: true,
      stdio: 'inherit',
      env: {
        ...env,
        AZURE_TRUSTED_SIGNING_ENDPOINT: config.endpoint,
        AZURE_TRUSTED_SIGNING_ACCOUNT: config.account,
        AZURE_TRUSTED_SIGNING_PROFILE: config.profile,
        LINKSHELL_SIGN_TIMESTAMP: config.timestampUrl,
        LINKSHELL_SIGN_FILES: targets.join(delimiter),
      },
    });
    return { signed: true, mode: config.mode, method: 'invoke-trusted-signing', files: targets };
  }

  let scratch;
  try {
    let certPath = config.pfxPath;
    if (!certPath && config.pfxBase64) {
      scratch = mkdtempSync(join(tmpdir(), 'linkshell-pfx-'));
      certPath = join(scratch, 'signing-cert.pfx');
      writeFileSync(certPath, Buffer.from(config.pfxBase64, 'base64'), { mode: 0o600 });
    }
    const signtool = (options.findSigntool ?? findSigntool)(env);
    log(`[sign] Signing ${targets.length} file(s) with Authenticode PFX via ${signtool}`);
    const args = [
      'sign',
      '/fd', 'SHA256',
      '/tr', config.timestampUrl,
      '/td', 'SHA256',
      '/f', certPath,
    ];
    if (config.password) {
      args.push('/p', config.password);
    }
    args.push(...targets);
    run(signtool, args, { windowsHide: true, stdio: 'inherit', env });
    return { signed: true, mode: 'pfx', method: 'signtool-pfx', files: targets };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
