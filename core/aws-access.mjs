// Read-only AWS for a sandbox (Alex, 11-11, W-420): a seat asks, Alex approves on the dashboard, and the factory runs
// built-rails bin/sbx-obs-creds (a one-hour ObservabilityReadOnly token, never --session) and allows the AWS hosts it
// names for that one sandbox. No agent runs the script.
const fail = msg => { throw new Error(msg); };
export const AWS_KINDS = ['aws_request', 'aws_decide', 'aws_op'];
export const TOKEN_MS = 3600000;
const SANDBOX = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** Apply one AWS-access row to state.awsRequests in place; returns the AR id. */
export function foldAwsRequest(state, { kind, target, payload: p, ctx }) {
  state.awsRequests ??= {}; state.nextAwsRequest ??= 1;
  if (kind === 'aws_request') {
    for (const k of ['work', 'sandbox', 'why']) if (!String(p[k] ?? '').trim()) fail(`An AWS access request needs "${k}".`);
    if (!SANDBOX.test(p.sandbox)) fail(`"${p.sandbox}" is not a sandbox name.`);
    if (!state.work[p.work]) fail(`There is no work item ${p.work}.`);
    const open = Object.values(state.awsRequests).find(r => r.sandbox === p.sandbox && ['requested', 'approved'].includes(r.status));
    if (open) fail(`${p.sandbox} already has ${open.id} waiting for Alex.`);
    const id = `AR-${state.nextAwsRequest++}`;
    state.awsRequests[id] = { id, work: p.work, sandbox: p.sandbox, why: String(p.why).slice(0, 1000), status: 'requested', from: ctx.by, at: ctx.now, approvedBy: null, approvedAt: null, expiresAt: null, detail: null };
    return id;
  }
  const r = state.awsRequests?.[target] || fail(`There is no AWS access request ${target}.`);
  if (kind === 'aws_decide') {
    // An expired grant can be renewed: a long investigation outlives the hour.
    const renew = r.status === 'granted' && Date.parse(ctx.now) >= Date.parse(r.expiresAt);
    if (!['requested', 'failed'].includes(r.status) && !renew) fail(`${target} is ${r.status}.`);
    state.awsRequests[target] = p.decision === 'approve' ? { ...r, status: 'approved', approvedBy: ctx.by, approvedAt: ctx.now, detail: null }
      : p.decision === 'decline' ? { ...r, status: 'declined', approvedBy: ctx.by, approvedAt: ctx.now, detail: p.note || null } : fail('A decision is approve or decline.');
  } else {
    if (r.status !== 'approved') fail(`${target} isn't approved.`);
    if (!['granted', 'failed'].includes(p.status)) fail('An AWS access outcome is granted or failed.');
    state.awsRequests[target] = { ...r, status: p.status, expiresAt: p.status === 'granted' ? new Date(Date.parse(ctx.now) + TOKEN_MS).toISOString() : r.expiresAt, detail: p.detail || null };
  }
  return target;
}

/** The AWS hosts bin/sbx-obs-creds lets bin/obs reach: the allow list in its kit template, read from the script itself. */
export function obsHosts(script) {
  const m = String(script).match(/\n\s*allow:\n((?:\s+- [^\n]+\n)+)/);
  return m ? m[1].split('\n').map(l => l.trim().replace(/^- /, '')).filter(Boolean) : [];
}

/**
 * Alex's decisions. `host` does the host-side work: script() → the script's text from built-rails origin/main,
 * creds(sandbox, script) runs it with --name only, allow(sandbox, hosts) adds a sandbox-scoped egress rule.
 */
export async function decideAwsRequests(store, ids, decision, note, host, now) {
  const by = { now: now(), by: 'Alex (dashboard)' }, out = [];
  for (const id of [...new Set(ids)]) {
    try {
      store.append({ kind: 'aws_decide', target: id, payload: { decision, note } }, by);
      const r = store.state.awsRequests[id];
      if (decision !== 'approve') { store.append({ kind: 'event', target: r.work, payload: { type: 'note', text: `AWS read access for ${r.sandbox} (${id}) declined by Alex${note ? `: ${note}` : ''}.` } }, by); out.push({ id, ok: true }); continue; }
      try {
        if (!host) throw new Error('this factory has no host runner');
        const script = await host.script();
        const hosts = obsHosts(script);
        if (!hosts.length) throw new Error("couldn't read the AWS host list from bin/sbx-obs-creds");
        await host.creds(r.sandbox, script);
        await host.allow(r.sandbox, hosts);
      } catch (e) {
        const login = /refusing to run as this identity|sso|expired|Unable to locate credentials/i.test(e.message) ? ' The host AWS login looks missing or expired: run `aws sso login` with the Observer profile, then Retry.' : '';
        store.append({ kind: 'aws_op', target: id, payload: { status: 'failed', detail: `${e.message.slice(0, 400)}${login}` } }, by);
        out.push({ id, error: e.message }); continue;
      }
      store.append({ kind: 'aws_op', target: id, payload: { status: 'granted' } }, by);
      const until = store.state.awsRequests[id].expiresAt;
      store.append({ kind: 'event', target: r.work, payload: { type: 'note', text: `AWS read access granted to ${r.sandbox} (${id}, Alex approved): ObservabilityReadOnly profile written into the sandbox and bin/obs's AWS hosts allowed for it. The token expires ${until.slice(11, 16)}Z; ask again (request_aws) for another hour.` } }, by);
      store.append({ kind: 'message', payload: { to: r.from, work: r.work, about: { awsGranted: id }, text: `[software factory] AWS read access for ${r.sandbox} is live (${id}), until ${until.slice(11, 16)}Z. Have the worker run bin/obs in the sandbox. Request again for another hour.` } }, by);
      out.push({ id, ok: true, expiresAt: until });
    } catch (e) { out.push({ id, error: e.message }); }
  }
  return out;
}
