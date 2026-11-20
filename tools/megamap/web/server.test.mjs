import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMegamapHandler } from './server.mjs';

async function fixture(t, projectCount = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'spamton-megamap-server-'));
  const binary = join(dir, 'spamton-mock-worker.mjs');
  await writeFile(binary, `#!${process.execPath}
import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';import {join} from 'node:path';import {spawn} from 'node:child_process';
const root=process.argv[process.argv.indexOf('--root')+1];appendFileSync(join(root,'spamton-spawns.log'),process.pid+'\\n');
createInterface({input:process.stdin}).on('line',async line=>{const r=JSON.parse(line);if(r.options?.crashWithChild){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:r.options.inherit?'inherit':'ignore'});appendFileSync(join(root,'spamton-child.log'),c.pid+'\\n');process.exit(2);}if(r.options?.crash)process.exit(2);if(r.options?.progress){process.stdout.write(JSON.stringify({id:r.id,progress:{phase:'parse',message:'Parsing fixture files',completed:1,total:2,elapsedMs:5}})+'\\n');await new Promise(done=>setTimeout(done,200));}if(r.options?.slow)await new Promise(done=>setTimeout(done,100));if(r.options?.child){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});appendFileSync(join(root,'spamton-child.log'),c.pid+'\\n');}process.stdout.write(JSON.stringify({id:r.id,result:{op:r.op,node:r.node,options:r.options,argv:process.argv.slice(2),pid:process.pid,large:r.options?.large?'x'.repeat(1024*1024):null}})+'\\n');});process.stdin.on('end',()=>process.exit(0));
`, { mode: 0o755 });
  const projects = [];
  for (let i = 0; i < projectCount; i++) { const root = join(dir, 'p' + i); await mkdir(root); projects.push({ id: 'p' + i, label: 'Project ' + i, root }); }
  const handler = await createMegamapHandler({ prefix: '/maps', projects, binary });
  const server = http.createServer((req, res) => { handler.handle(req, res).then(done => { if (!done) { res.statusCode = 404; res.end('Factory route'); } }); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}/maps/`;
  const config = await (await fetch(base + 'api/config')).json();
  const request = (route, options = {}) => fetch(base + route, { ...options, headers: { 'x-megamap-token': config.token, ...options.headers } });
  const post = (route, value) => request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  t.after(async () => { await handler.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(dir, { recursive: true, force: true }); });
  return { base, handler, server, config, request, post, projects };
}

test('mount is relative, leaves other factory routes alone and exposes only registered labels', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.config.projects, [{ id: 'p0', label: 'Project 0' }]);
  assert.equal(f.config.capabilities.capture, false);
  const response = await fetch(f.base.slice(0, -1), { redirect: 'manual' });
  assert.equal(response.headers.get('location'), '/maps/');
  assert.equal((await fetch(f.base.replace('/maps/', '/api/board'))).status, 404);
  assert.equal((await fetch(f.base + 'server.mjs')).status, 404);
  assert.equal((await f.post('api/view?project=/private/tmp', {})).status, 404);
});

test('cross-origin, rebinding and missing or malformed tokens cannot read source or start a worker', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + 'api/source?project=p0&node=1')).status, 403);
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.example:' + f.server.address().port }, { 'x-megamap-token': 'é'.repeat(64) }]) {
    const status = await new Promise((done,reject) => {
      const request=http.request(f.base+'api/source?project=p0&node=1',{headers:{'x-megamap-token':f.config.token,...headers}},response=>{response.resume();response.on('end',()=>done(response.statusCode));});
      request.on('error',reject);request.end();
    });
    assert.equal(status,403,JSON.stringify(headers));
  }
  await assert.rejects(readFile(join(f.projects[0].root, 'spamton-spawns.log')));
});

test('view and source use serialized numeric IDs, complete large JSON frames and a bounded protocol', async t => {
  const f = await fixture(t);
  const result = await (await f.post('api/view?project=p0', { large: true })).json();
  assert.equal(result.op, 'view'); assert.equal(result.large.length, 1024 * 1024);
  assert.equal(result.argv.includes('--allow-capture'), false);
  const source = await (await f.request('api/source?project=p0&node=7&syntax=0')).json();
  assert.equal(source.node, 7);
  for (const node of ['-1', '../outside', '1.2', '9007199254740992']) assert.equal((await f.request('api/source?project=p0&node=' + encodeURIComponent(node))).status, 400);
  assert.equal((await f.request('api/source?project=p0&node=1&syntax=maybe')).status, 400);
});

test('status stays responsive during analysis and snapshot import does not enable live capture', async t => {
  const f = await fixture(t);
  const pending = f.post('api/view?project=p0', { slow: true });
  for (let i = 0; i < 30; i++) { if ((await (await f.request('api/status?project=p0')).json()).loading) break; await new Promise(done => setTimeout(done, 5)); }
  assert.equal((await (await f.request('api/status?project=p0')).json()).loading, true);
  assert.equal((await pending).status, 200);
  assert.equal((await f.post('api/capture?project=p0', {})).status, 403);
  assert.equal((await (await f.post('api/evidence?project=p0', { snapshot: '{}' })).json()).op, 'evidence');
  assert.equal((await f.post('api/evidence?project=p0', { snapshot: 7 })).status, 400);
  assert.equal((await f.request('api/view?project=p0', { method: 'POST', body: '{}' })).status, 415);
});

test('concurrent project acquisition creates one owned worker and refresh restarts it with reset trace IDs', async t => {
  const f = await fixture(t);
  const views = await Promise.all(Array.from({ length: 8 }, () => f.post('api/view?project=p0', {})));
  assert(views.every(r => r.status === 200));
  const first = await views[0].json();
  assert.equal((await readFile(join(f.projects[0].root, 'spamton-spawns.log'), 'utf8')).trim().split('\n').length, 1);
  const next = await (await f.post('api/refresh?project=p0', { traceRoot: 99, direction: 'callers', evidence: 'observed', filter: 'app/' })).json();
  assert.notEqual(next.pid, first.pid); assert.equal(next.options.traceRoot, null); assert.equal(next.options.direction, 'all'); assert.equal(next.options.filter, 'app/');
});

test('worker failure is reported and next request rebuilds cleanly', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('api/view?project=p0', { crash: true })).status, 503);
  assert.equal((await f.post('api/view?project=p0', {})).status, 200);
});

test('closing the mounted service cancels pending work promptly', async t => {
  const f = await fixture(t);
  const pending = f.post('api/view?project=p0', { slow: true });
  for (let i = 0; i < 30; i++) { if ((await (await f.request('api/status?project=p0')).json()).loading) break; await new Promise(done => setTimeout(done, 5)); }
  const start = Date.now(); await f.handler.close(); assert(Date.now() - start < 1500);
  assert.equal((await pending).status, 503);
  assert.equal((await f.request('api/status?project=p0')).status, 503);
});


test('abnormal worker exit and service shutdown leave no owned descendants', async t => {
  for (const inherit of [false,true]) {
  const f=await fixture(t);let pid;
  const running=()=>{try {const state=execFileSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}).trim();return Boolean(state)&&!state.startsWith('Z');}catch{return false;}};
  try {
    const request=f.post('api/view?project=p0',{crashWithChild:true,inherit});
    const response=await Promise.race([request,new Promise(done=>setTimeout(()=>done(null),1200))]);
    assert(response,'worker exit did not settle while an inherited output pipe remained open');
    assert.equal(response.status,503);
    pid=Number((await readFile(join(f.projects[0].root,'spamton-child.log'),'utf8')).trim());
    await f.handler.close();
    for(let i=0;i<30&&running();i++)await new Promise(done=>setTimeout(done,10));
    assert.equal(running(),false,'worker descendant survived its process leader');
  } finally {if(pid&&running())process.kill(pid,'SIGKILL');}
  }
});

test('worker host refuses to signal a group it does not own', async t => {
  const f=await fixture(t);
  const {spawn}=await import('node:child_process');
  const host=spawn(process.execPath,[new URL('./worker-host.mjs',import.meta.url).pathname,'/does/not/exist'],{stdio:'ignore',detached:false});
  const code=await new Promise(done=>host.once('close',done));
  assert.equal(code,2);
  assert.equal((await f.post('api/view?project=p0',{})).status,200);
});


test('public page navigation works from an outside link while bootstrap data stays same-origin', async t => {
  const f=await fixture(t);
  const headers={origin:'https://example.test','sec-fetch-site':'cross-site'};
  const page=await fetch(f.base,{headers});assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'self'/);
  assert.equal((await fetch(f.base+'api/config',{headers})).status,403);
  assert.equal((await f.request('api/source?project=p0&node=1',{headers})).status,403);
});


test('PR requests reject invalid numbers and expired or cross-project comparison IDs before starting analysis', async t => {
  const f = await fixture(t, 2);
  for (const number of [0, -1, 1.5, '../42', 2147483648, null]) assert.equal((await f.post('api/pr?project=p0', { number })).status, 400);
  for (const comparison of ['../outside', 'a'.repeat(32)]) {
    assert.equal((await f.post('api/view?project=p0&comparison=' + encodeURIComponent(comparison), {})).status, 404);
    assert.equal((await f.request('api/source?project=p1&comparison=' + encodeURIComponent(comparison) + '&node=1')).status, 404);
  }
  await assert.rejects(readFile(join(f.projects[0].root, 'spamton-spawns.log')));
  assert.equal((await f.post('api/view?project=p0', {})).status, 200);
});


test('progress reports real counters without completing the active operation', async t => {
  const f=await fixture(t);let settled=false;
  const pending=f.post('api/view?project=p0',{progress:true}).then(r=>{settled=true;return r;});
  let observed;
  for(let i=0;i<100;i++){const value=await(await f.request('api/status?project=p0')).json();if(value.progress){observed=value;break;}await new Promise(done=>setTimeout(done,5));}
  assert.equal(observed?.loading,true);assert.equal(observed.progress.phase,'parse');assert.equal(observed.progress.completed,1);assert.equal(observed.progress.total,2);assert.equal(settled,false,'progress is not a result');
  assert.equal((await pending).status,200);assert.equal((await(await f.request('api/status?project=p0')).json()).loading,false);
});


test('embedded viewer requires an explicit analysis worker path from its host', async () => {
  await assert.rejects(createMegamapHandler({projects:[{id:'fixture',root:process.cwd()}]}), /analysis worker path/);
});
