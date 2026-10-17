const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const r = createRequire(process.argv[2] + '/Contents/Resources/runtime/cli/package.json');
(async () => {
  const db = new DatabaseSync(':memory:'); db.exec('create table test (n integer); insert into test values (1)');
  if(db.prepare('select n from test').get().n !== 1) throw new Error('sqlite'); db.close();
  const hostRequire = createRequire(r.resolve('@linkshell/host'));
  const sharp = hostRequire('sharp');
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#22aa88' } }).png().toBuffer();
  const output = await new Promise((resolve, reject) => {
    const p = r('node-pty').spawn('/bin/sh', ['-c', 'printf standalone-pty-ok'], { env: { PATH: '/usr/bin:/bin' } });
    let value = ''; p.onData(data => value += data); p.onExit(e => e.exitCode === 0 ? resolve(value) : reject(new Error('PTY exit ' + e.exitCode)));
  });
  if (!output.includes('standalone-pty-ok')) throw new Error('PTY output');
  console.log(JSON.stringify({ architecture: process.arch, node: process.version, sqlite: true, sharp: image.length > 0, pty: true }));
})().catch(e => { console.error(e); process.exitCode = 1; });
