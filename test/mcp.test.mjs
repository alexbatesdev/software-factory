import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcp } from '../mcp/server.mjs';

const config = { roles: { 'local-head': 'local-head', 'questions router': 'questions-router' }, routing: { supervisors: { 'sup: s1': {} } } };
const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
const fake = () => { const calls = []; return { calls, get: async path => (path === '/api/inbox' ? { messages: [] } : { work: { 'W-1': { id: 'W-1', title: 'T', phase: 'intake' } } }), post: async (action, args, seat) => { calls.push([action, args, seat]); return { ok: true }; } }; };

test("a seat sees only its role's tools, and calls carry its seat, never a claimed name", async () => {
  const api = fake();
  const mcp = createMcp({ config, seatOf: async () => 'questions router', api });
  assert.equal((await mcp(rpc('initialize', { protocolVersion: '2025-06-18' }))).result.serverInfo.name, 'software-factory');
  const names = (await mcp(rpc('tools/list'))).result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['create', 'inbox', 'read', 'route', 'set_owner']);
  const r = await mcp(rpc('tools/call', { name: 'route', arguments: { id: 'TB-1', to: 'sup: s1', by: 'Alex' } }));
  assert.equal(r.result.isError, false);
  assert.deepEqual(api.calls, [['route', { id: 'TB-1', to: 'sup: s1', by: 'Alex' }, 'questions router']]);
  assert.equal((await mcp(rpc('tools/call', { name: 'done', arguments: { work: 'W-1' } }))).result.isError, true);
  assert.equal(await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('an unknown seat gets no tools', async () => {
  const mcp = createMcp({ config, seatOf: async () => 'some pane', api: fake() });
  assert.deepEqual((await mcp(rpc('tools/list'))).result.tools, []);
});
