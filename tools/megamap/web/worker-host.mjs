import { spawn, execFileSync } from 'node:child_process';

const [binary, ...args] = process.argv.slice(2);
if (!binary || process.platform === 'win32') process.exit(2);
let group;
try { group = Number(execFileSync('ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim()); }
catch { process.exit(2); }
if (group !== process.pid) {
  console.error('Megamap worker host must run in its own detached process group');
  process.exit(2);
}
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  process.exit(1);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdin.once('end', stop);
process.stdin.once('error', stop);
process.stdout.once('error', stop);
process.stderr.once('error', stop);
const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
child.once('error', stop);
child.once('exit', stop);
child.stdin.once('error', stop);
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
