import { createInterface } from 'node:readline';
import { prepareComparison, resolvePullRequest } from './pr-snapshots.mjs';
let resolved = false, prepared = false, queue = Promise.resolve();
const progressEnabled = process.argv.includes('--progress');
createInterface({ input: process.stdin }).on('line', line => { queue = queue.then(async () => {
  let request;
  try {
    request = JSON.parse(line);
    const started = Date.now();
    const onProgress = value => { if (progressEnabled) process.stdout.write(JSON.stringify({ id: request.id, progress: { ...value, elapsedMs: Date.now() - started } }) + '\n'); };
    let result;
    if (request.op === 'resolve') {
      if (resolved || prepared) throw new Error('PR preparation accepts one metadata lookup'); resolved = true;
      result = await resolvePullRequest(request.project, request.number, { onProgress });
    } else if (request.op === 'prepare') {
      if (prepared) throw new Error('PR preparation accepts one snapshot request'); prepared = true;
      result = await prepareComparison(request.project, request.number, request.directory, { resolved: request.resolved, onProgress });
    } else throw new Error('Unknown PR preparation operation');
    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ id: request?.id ?? null, error: String(error.message).slice(0, 2048) }) + '\n'); }
}); });
