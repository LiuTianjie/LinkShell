import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
const helper = resolve(process.argv[2] ?? 'build/LinkShell.Screen.exe');
const width = Number(process.argv[3] ?? 1280), fps = Number(process.argv[4] ?? 30);
const duration = Number(process.argv[5] ?? 10);
const child = spawn(helper, ['--capture', '0', String(width), String(fps)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const exit = once(child, 'exit');
let buffered = Buffer.alloc(0), errors = '', first, last, frames = 0, bytes = 0, lastFrame;
const intervals = [];
child.stderr.on('data', part => errors += part.toString());
child.stdout.on('data', part => {
  buffered = Buffer.concat([buffered, part]);
  while (buffered.length >= 4 && buffered.length >= buffered.readUInt32LE(0) + 4) {
    const size = buffered.readUInt32LE(0), now = performance.now();
    first ??= now;
    if (last) intervals.push(now - last);
    last = now; frames++; bytes += size;
    lastFrame = Buffer.from(buffered.subarray(4, size + 4));
    buffered = buffered.subarray(size + 4);
  }
});
const started = performance.now();
const timeout = setTimeout(() => child.stdin.end(), duration * 1000);
const kill = setTimeout(() => child.kill(), (duration + 5) * 1000);
const [code] = await exit;
clearTimeout(timeout); clearTimeout(kill);
if (code !== 0 || !frames) throw new Error(errors || `Capture ended ${code}`);
if (process.env.LINKSHELL_SCREEN_DIAGNOSTICS) console.error(errors.trim());
intervals.sort((a, b) => a - b);
if (process.env.LINKSHELL_BENCH_FRAME) writeFileSync(process.env.LINKSHELL_BENCH_FRAME, lastFrame);
console.log(JSON.stringify({ helper, width, requestedFps: fps, seconds: +( (performance.now() - started) / 1000).toFixed(2), frames, fps: frames > 1 ? +((frames - 1) * 1000 / (last - first)).toFixed(1) : 0, averageFrameKB: +(bytes / frames / 1024).toFixed(1), megabitsPerSecond: +(bytes * 8 / duration / 1e6).toFixed(2), intervalP50: +intervals[Math.floor(intervals.length * .5)]?.toFixed(1), intervalP95: +intervals[Math.floor(intervals.length * .95)]?.toFixed(1) }));
