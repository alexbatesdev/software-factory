#!/usr/bin/env python3
"""Token usage inside time windows, from Claude Code or Codex session logs (W-561). Read-only.
usage.py <claude|codex> '<[[start_iso, end_iso], ...]>' [session_id]  ->  {"byModel": {model: {input, cacheWrite5m, cacheWrite1h, cacheRead, output}}, "files": n}
Claude: every assistant entry with message.usage, deduplicated by message id. Codex: the growth of total_token_usage between
token_count events, so a repeated event counts once. A session id limits Claude to that session's file and its subagents."""
import glob, json, os, sys
from datetime import datetime

def ts(s): return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

kind, windows = sys.argv[1], [(ts(a), ts(b)) for a, b in json.loads(sys.argv[2])]
session = sys.argv[3] if len(sys.argv) > 3 else None
home = os.environ.get('USAGE_HOME') or os.path.expanduser('~')
start = min((a for a, _ in windows), default=0)
inside = lambda t: any(a <= t <= b for a, b in windows)
by = {}
def add(model, **k):
    m = by.setdefault(model or 'unknown', {'input': 0, 'cacheWrite5m': 0, 'cacheWrite1h': 0, 'cacheRead': 0, 'output': 0})
    for f, v in k.items(): m[f] += v or 0

if kind == 'claude':
    pat = f'{home}/.claude/projects/*/{session}*' if session else f'{home}/.claude/projects/**/*.jsonl'
    files = [f for p in ([pat + '.jsonl', pat + '/**/*.jsonl'] if session else [pat]) for f in glob.glob(p, recursive=True)]
    seen = set()
    for f in files:
        if os.path.getmtime(f) < start: continue
        for line in open(f, errors='replace'):
            try: e = json.loads(line)
            except ValueError: continue
            msg = e.get('message') if isinstance(e.get('message'), dict) else None
            u = msg and msg.get('usage')
            if not u or not e.get('timestamp') or not inside(ts(e['timestamp'])) or msg.get('id') in seen: continue
            seen.add(msg.get('id'))
            cc = u.get('cache_creation') or {}
            w1h = cc.get('ephemeral_1h_input_tokens', 0)
            add(msg.get('model'), input=u.get('input_tokens'), cacheWrite5m=(u.get('cache_creation_input_tokens') or 0) - w1h, cacheWrite1h=w1h,
                cacheRead=u.get('cache_read_input_tokens'), output=u.get('output_tokens'))
else:
    files = glob.glob(f'{home}/.codex/sessions/**/*.jsonl', recursive=True)
    for f in files:
        if os.path.getmtime(f) < start: continue
        model, prev = None, {}
        for line in open(f, errors='replace'):
            try: e = json.loads(line)
            except ValueError: continue
            p = e.get('payload') or {}
            if e.get('type') == 'turn_context': model = p.get('model') or model
            if p.get('type') != 'token_count' or not (p.get('info') or {}).get('total_token_usage'): continue
            t = p['info']['total_token_usage']
            if e.get("timestamp") and inside(ts(e['timestamp'])):
                d = {k: (t.get(k) or 0) - (prev.get(k) or 0) for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')}
                if any(v > 0 for v in d.values()):
                    add(model, input=d['input_tokens'] - d['cached_input_tokens'], cacheRead=d['cached_input_tokens'], output=d['output_tokens'])
            prev = t
print(json.dumps({'byModel': by, 'files': len(files)}))
