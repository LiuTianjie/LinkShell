import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { resolveSigningConfig, signWindowsBinaries } from '../scripts/sign.mjs';

test('skips signing cleanly when neither Azure Trusted Signing nor PFX env vars are set', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkshell-sign-skip-'));
  try {
    const exe = join(root, 'LinkShell.exe');
    writeFileSync(exe, 'MZ-fake');
    const logs = [];
    const calls = [];
    const result = signWindowsBinaries([exe], {
      env: {},
      log: (msg) => logs.push(msg),
      execFile: (...args) => calls.push(args),
    });
    assert.equal(result.signed, false);
    assert.equal(result.mode, 'skipped');
    assert.equal(calls.length, 0);
    assert.ok(logs.some((line) => line.includes('Skipping Authenticode signing')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('signs binaries with Invoke-TrustedSigning when AZURE_TRUSTED_SIGNING_* env vars are configured', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkshell-sign-acs-'));
  try {
    const exe = join(root, 'LinkShell.exe');
    const helper = join(root, 'LinkShell.Screen.exe');
    writeFileSync(exe, 'MZ-app');
    writeFileSync(helper, 'MZ-helper');
    const calls = [];
    const result = signWindowsBinaries([exe, helper], {
      env: {
        AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
        AZURE_TRUSTED_SIGNING_ACCOUNT: 'linkshell-signing',
        AZURE_TRUSTED_SIGNING_PROFILE: 'linkshell-public',
      },
      log: () => {},
      execFile: (cmd, args, opts) => calls.push({ cmd, args, opts }),
    });
    assert.equal(result.signed, true);
    assert.equal(result.mode, 'azure-trusted-signing');
    assert.equal(result.method, 'invoke-trusted-signing');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'powershell.exe');
    assert.equal(calls[0].opts.env.AZURE_TRUSTED_SIGNING_ACCOUNT, 'linkshell-signing');
    assert.equal(calls[0].opts.env.LINKSHELL_SIGN_FILES, [exe, helper].join(delimiter));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('signs binaries with signtool dlib when AZURE_TRUSTED_SIGNING_DLIB is provided and cleans up metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkshell-sign-dlib-'));
  try {
    const exe = join(root, 'LinkShell-Setup-1.0.0-windows-x64.exe');
    writeFileSync(exe, 'MZ-setup');
    let capturedMetadata;
    let metadataPath;
    const result = signWindowsBinaries([exe], {
      env: {
        AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
        AZURE_TRUSTED_SIGNING_ACCOUNT: 'linkshell-signing',
        AZURE_TRUSTED_SIGNING_PROFILE: 'linkshell-public',
        AZURE_TRUSTED_SIGNING_DLIB: 'C:\\Tools\\Azure.CodeSigning.Dlib.dll',
      },
      findSigntool: () => 'C:\\SDK\\signtool.exe',
      log: () => {},
      execFile: (_cmd, args) => {
        const dmdfIndex = args.indexOf('/dmdf');
        metadataPath = args[dmdfIndex + 1];
        capturedMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      },
    });
    assert.equal(result.signed, true);
    assert.equal(result.method, 'signtool-dlib');
    assert.deepEqual(capturedMetadata, {
      Endpoint: 'https://eus.codesigning.azure.net',
      CodeSigningAccountName: 'linkshell-signing',
      CertificateProfileName: 'linkshell-public',
    });
    assert.equal(existsSync(metadataPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('signs binaries with WINDOWS_PFX_BASE64 via signtool.exe and removes temporary PFX afterwards', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkshell-sign-pfx-'));
  try {
    const exe = join(root, 'LinkShell.exe');
    writeFileSync(exe, 'MZ-app');
    let tempPfxPath;
    let capturedArgs;
    const result = signWindowsBinaries([exe], {
      env: {
        WINDOWS_PFX_BASE64: Buffer.from('fake-pfx-bytes').toString('base64'),
        WINDOWS_PFX_PASSWORD: 'secret-password',
      },
      findSigntool: () => 'signtool.exe',
      log: () => {},
      execFile: (_cmd, args) => {
        capturedArgs = args;
        tempPfxPath = args[args.indexOf('/f') + 1];
        assert.equal(readFileSync(tempPfxPath, 'utf8'), 'fake-pfx-bytes');
      },
    });
    assert.equal(result.signed, true);
    assert.equal(result.mode, 'pfx');
    assert.ok(capturedArgs.includes('/p'));
    assert.equal(existsSync(tempPfxPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects partial Azure Trusted Signing configuration instead of silently skipping', () => {
  assert.throws(
    () => resolveSigningConfig({ AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net' }),
    /Incomplete Azure Trusted Signing configuration/,
  );
});
