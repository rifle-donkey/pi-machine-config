/* Internal subprocess supervisor: bound captured streams and terminate the command group. */
import { spawn } from 'node:child_process';

const [path, duration, ...args] = process.argv.slice(2);
const child = spawn(path!, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const limit = 1024 * 1024;
let out = 0, err = 0, failed = false;
function kill() {
  failed = true;
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The process group already exited. */ }
  }
}
const timer = setTimeout(kill, Number(duration));
child.stdout.on('data', (bytes: Buffer) => {
  out += bytes.length;
  if (out > limit) kill();
  else if (!failed) process.stdout.write(bytes);
});
child.stderr.on('data', (bytes: Buffer) => {
  err += bytes.length;
  if (err > limit) kill();
});
child.on('error', kill);
child.on('close', (status, signal) => {
  clearTimeout(timer);
  if (status !== 0 || signal) kill();
  process.exitCode = failed ? 1 : 0;
});
