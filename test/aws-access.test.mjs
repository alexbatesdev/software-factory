import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { openStore } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';
import { obsHosts } from '../core/aws-access.mjs';

// Alex, 11-11 (W-420): AWS credentials reach a sandbox only when he runs bin/sbx-obs-creds, or the factory does after his approval.
const SUP = 'sup: stream-1', T = '2026-11-11T22:00:00.000Z', SB = 'herdr-claude-code-ad7960e5d7f2';
const config = { roles: { 'triage board worker': 'board-developer' }, routing: { supervisors: { [SUP]: {} } } };
const SCRIPT = 'x\npermissions:\n  network:\n    allow:\n      - sts.us-east-1.amazonaws.com\n      - logs.us-east-1.amazonaws.com\n      - sentry.io\nYAML\n';
const ask = { work: 'W-1', sandbox: SB, why: 'Kyverna: read the Lever refusal in production logs' };

async function serve(host, now = () => T) {
  const store = openStore(':memory:', { supervisors: [SUP] });
  store.append({ kind: 'create', payload: { title: 'Kyverna', stream: SUP } }, { now: T, by: 'test' });
  const server = http.createServer(createApi({ store, config, awsHost: host, now }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, seat) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory': '1', ...(seat ? { 'x-seat': seat } : {}) }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
  return { store, act: (args, seat = SUP) => post('/api/actions', { action: 'request_aws', args }, seat), decide: body => post('/api/aws-requests', body), board: async () => (await fetch(`${base}/api/board`)).json(), close: () => server.close() };
}

test('the AWS hosts come from the script itself, so the factory never keeps its own copy', () => {
  assert.deepEqual(obsHosts(SCRIPT), ['sts.us-east-1.amazonaws.com', 'logs.us-east-1.amazonaws.com', 'sentry.io']);
});

test("a supervisor asks; nothing runs until Alex approves; then the script runs with --name only, the hosts are allowed for that sandbox, and the grant's hour is on the record", async () => {
  const calls = [];
  const host = { script: async () => SCRIPT, creds: async (sb, s) => calls.push(['creds', sb, s === SCRIPT]), allow: async (sb, hosts) => calls.push(['allow', sb, hosts.length]) };
  const f = await serve(host);
  try {
    assert.equal((await f.act(ask))[0], 200);
    assert.equal((await f.act({ ...ask, sandbox: 'bad name;rm' }))[0], 400);
    assert.equal((await f.act(ask))[0], 400, 'one open request per sandbox');
    assert.deepEqual(calls, [], 'asking runs nothing');
    assert.deepEqual((await f.board()).awsRequests.map(r => [r.id, r.sandbox, r.status]), [['AR-1', SB, 'requested']]);
    const [code] = await f.decide({ ids: ['AR-1'], decision: 'approve' });
    assert.equal(code, 200);
    assert.deepEqual(calls, [['creds', SB, true], ['allow', SB, 3]]);
    const r = f.store.state.awsRequests['AR-1'];
    assert.deepEqual([r.status, r.expiresAt, r.approvedBy], ['granted', '2026-11-11T23:00:00.000Z', 'Alex (dashboard)']);
    assert.match(f.store.state.work['W-1'].updates.at(-1).text, /expires 23:00Z/);
    assert.ok(Object.values(f.store.state.messages).some(m => m.to === SUP && m.about?.awsGranted === 'AR-1'), 'the asker hears it is live');
  } finally { f.close(); }
});

test('a failed run shows why on the panel, naming the AWS login when that is the cause; declined requests say so on the record', async () => {
  const f = await serve({ script: async () => SCRIPT, creds: async () => { throw new Error('ERROR: refusing to run as this identity.'); }, allow: async () => assert.fail('no egress without credentials') });
  try {
    await f.act(ask);
    await f.decide({ ids: ['AR-1'], decision: 'approve' });
    const [r] = (await f.board()).awsRequests;
    assert.equal(r.status, 'failed');
    assert.match(r.detail, /aws sso login/);
    await f.act({ ...ask, sandbox: 'other-sandbox' });
    await f.decide({ ids: ['AR-2'], decision: 'decline', note: 'not needed' });
    assert.match(f.store.state.work['W-1'].updates.at(-1).text, /declined by Alex: not needed/);
  } finally { f.close(); }
});

test('only a stream supervisor asks, and the page lists requests with Approve and Decline', async () => {
  const { ROLES } = await import('../core/capabilities.mjs');
  assert.ok(ROLES['stream-supervisor'].includes('request_aws'));
  assert.ok(!ROLES['sbx-worker'].includes('request_aws'), 'a worker never asks for its own credentials');
  const page = readFileSync(new URL('../views/index.html', import.meta.url), 'utf8');
  assert.match(page, /AWS read access/);
  assert.match(page, /\/api\/aws-requests/);
});

test('the script runs with the configured AWS profile, and a login failure names the exact command (Alex, 11-11: NoCredentials on first Approve)', async () => {
  const seen = [];
  const f = await serve({ profile: 'Observer-Alex', script: async () => SCRIPT, creds: async () => { throw new Error('aws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials.'); }, allow: async () => {} });
  try {
    await f.act(ask);
    await f.decide({ ids: ['AR-1'], decision: 'approve' });
    assert.match(f.store.state.awsRequests['AR-1'].detail, /aws sso login --profile Observer-Alex/);
  } finally { f.close(); }
  const { obsAccess } = await import('../hosts/sbx.mjs');
  assert.equal(typeof obsAccess, 'function', 'built per profile');
  assert.equal(obsAccess('Observer-Alex').profile, 'Observer-Alex');
});
