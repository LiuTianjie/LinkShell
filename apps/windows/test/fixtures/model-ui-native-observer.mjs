// Observe the real official Codex stdio protocol in the copied CLI only. No response is replaced.
import childProcess from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';

const root = process.env.LINKSHELL_QA_ROOT;
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !root
  || readFileSync(join(root, 'qa-owner'), 'utf8') !== process.env.LINKSHELL_QA_TOKEN) {
  throw new Error('The native observer requires its disposable Windows CI fixture.');
}
const record = event => appendFileSync(join(root, 'native-events.jsonl'), JSON.stringify({ at: Date.now(), ...event }) + '\n');
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  const child = spawn.call(this, command, args, options);
  if (!/^codex(?:\.exe)?$/i.test(basename(command)) || !args?.includes('app-server')) return child;
  record({ event: 'app-server-start', pid: child.pid });
  const pending = new Map();
  const observeLines = consume => {
    let buffer = '';
    return chunk => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        consume(message);
      }
    };
  };
  const requests = observeLines(message => {
    if (!message.method) return;
    // Fail before native code receives any inference request, even if an unexpected UI action sends one.
    if (['turn/start', 'turn/steer', 'command/exec'].includes(message.method)) {
      record({ event: 'forbidden-request', method: message.method });
      throw new Error('Inference is forbidden in the model UI E2E.');
    }
    if (message.id !== undefined) pending.set(message.id, message.method);
    record({ event: 'request', method: message.method,
      ...(message.method === 'thread/start' ? { model: message.params?.model } : {}) });
  });
  const write = child.stdin.write;
  child.stdin.write = function (chunk, ...rest) { requests(chunk); return write.call(this, chunk, ...rest); };
  child.stdout.on('data', observeLines(message => {
    const method = pending.get(message.id); if (!method) return;
    pending.delete(message.id);
    const result = message.result;
    const detail = method === 'account/read' ? { accountNull: result?.account === null, requiresOpenaiAuth: result?.requiresOpenaiAuth }
      : method === 'model/list' ? { models: result?.data?.map(model => ({ model: model.model, isDefault: model.isDefault })) }
        : method === 'thread/start' ? { threadId: result?.thread?.id, turns: result?.thread?.turns?.length, model: result?.model } : {};
    record({ event: 'response', method, ok: !message.error, ...detail });
  }));
  return child;
};
syncBuiltinESMExports();
