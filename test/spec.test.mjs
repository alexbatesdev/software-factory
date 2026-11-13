import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, parseDecisions } from '../core/spec.mjs';

const SPEC = `---
type: spec
teamwork_task: https://acme.teamwork.com/app/tasks/41384290
---
# Spec
## Requirements
### The field
| ID | Requirement | Notes |
| --- | --- | --- |
| REQ-001 | A position has an optional end date. | D-005 |
| REQ-015 | A field map can set it conditionally. | D-036 (dev to verify) |
## Acceptance criteria
| Req ID | Acceptance criteria |
| --- | --- |
| REQ-001 | An admin can save a position with and without an end date. |
| REQ-001 | The saved date shows unchanged everywhere. |
`;

test('a spec yields its Teamwork parent, its requirements with dev-to-verify notes, and acceptance criteria per REQ', () => {
  const s = parseSpec(SPEC);
  assert.equal(s.teamworkTask, '41384290');
  assert.deepEqual(Object.keys(s.reqs), ['REQ-001', 'REQ-015']);
  assert.equal(s.reqs['REQ-015'].devToVerify, true);
  assert.equal(s.reqs['REQ-001'].devToVerify, false);
  assert.deepEqual(s.acs.map(a => a.req), ['REQ-001', 'REQ-001']);
});

test('decisions yield their status and who they need', () => {
  const d = parseDecisions('# Decisions\n### D-010 — Can mapping express it?\n- status: open\n- needs: dev to verify\n\n### D-011 — Done one\n- status: decided\n');
  assert.deepEqual(d, [{ id: 'D-010', title: 'Can mapping express it?', status: 'open', needs: 'dev to verify' }, { id: 'D-011', title: 'Done one', status: 'decided', needs: null }]);
});
