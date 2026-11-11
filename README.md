# Software factory

The board that runs Alex's delivery work. Every piece of work is a `W-n` record. Agents in herdr panes take records, build them in sandboxes, review them and report back. Alex sees the result at http://127.0.0.1:4848 and answers only real product questions.

The factory decides and records. Agents do the work. Alex approves and merges.

## Run it

```bash
node bin/factory.mjs           # every seat and what `up` would do; changes nothing
node bin/factory.mjs up        # sync skills and standards, start the server and every stopped seat
node bin/factory.mjs down --yes  # stop every seat except the ones marked `stays` in config.json
```

herdr needs the sandbox off. The server alone:

```bash
FACTORY_MODE=live node --env-file="$HOME/Code/repos/teamwork mini mcp/.env" bin/live.mjs
```

- `4848`: the dashboard and API (`FACTORY_PORT`).
- `4849`: the port sbx workers reach from inside their sandboxes (`FACTORY_SANDBOX_PORT`). A token proves which sandbox is calling.
- `FACTORY_DRY=1` logs what it would do without writing anywhere.
- Logs go to `data/live.log`; the event log is `data/factory.db`. Both are untracked.

## How it works

**One append-only log.** Every change is a row in SQLite (`core/store.mjs`). Board state is the fold of those rows, so restarting the server rebuilds the same board. Anything a reducer reads from the outside world (the time, a GitHub read) is stored on the row, so a replay never asks GitHub again. A rule change that would rewrite history is date-gated (`*_FROM` constants).

**A pure core, thin edges.**

| Folder | What it holds |
|---|---|
| `core/` | Records, the ready gate, dispatch, inbox and wake decisions, questions, review threads, Teamwork task requests. Pure functions, no I/O. |
| `sources/` | Reads: GitHub (`gh`) and Teamwork (through teamwork-mini's client). |
| `effects/` | The few writes outside the log: mark a PR ready, resolve a review thread. Each is read back to confirm. |
| `hosts/` | Worker sandboxes (sbx): disk checks, restarts, recycles, model and effort. |
| `fleet/` | herdr panes: who is running, what they're doing, starting and stopping seats. |
| `views/` | The dashboard: `board.mjs` turns state into cards; `index.html` is the page. |
| `mcp/` | The MCP server agents use: one tool per board action their role holds. |
| `bin/` | Entry points: `live.mjs` (the server and its polling loops), `factory.mjs` (seats), `mcp.mjs`. |

**The live loop** (`bin/live.mjs`), every few seconds to minutes:

1. Reads GitHub and Teamwork, and joins each PR and task to its record (`core/correlate.mjs`).
2. Auto-dispatches ready records to the least-loaded free stream (`core/dispatch.mjs`). Support and priority work go first.
3. Messages each seat what it needs to know, and wakes it if it hasn't acked (`core/inbox.mjs`, `core/wake.mjs`).
4. Marks a PR ready on GitHub once its internal review is clean (Alex's standing authorization).
5. Closes records whose PRs merged, and releases holds waiting on those merges.
6. Runs an hourly audit: an own PR or a piece of feedback no record holds goes to the board developer as a factory gap.

## Who does what

Each role is a Claude (or Codex) session in a herdr pane. Behaviour lives in the role file (`~/Code/.claude/agents/<role>.md`). What a role may do lives in `core/capabilities.mjs`, and the API enforces it.

| Seat | Role | Does |
|---|---|---|
| `local-head` | Alex's chat | Turns what Alex says into board actions: answers, new records, priorities. |
| `board lead` | Runs the factory | Triages new records, checks the board against reality hourly, files factory bugs. |
| `questions router` | Routing | Gives answers and unowned items an owner. |
| `sup: <stream>` | Stream supervisor | Takes its stream's records, briefs its worker by file, records every step. |
| `sbx: <stream>` | Worker | Does the repo work in a Docker sandbox and reports with `progress`. |
| `triage board worker` | Board developer | Builds this repo. |

Streams: `stream-1` (Claude), `stream-2` (Codex), and `host` (workers on the host for repos a sandbox can't reach, such as built-customer-implementations and teamwork-mini-mcp).

## A record's life

```
intake → ready → queued → implementation → review → (fixes → rereview) → ready_for_human → awaiting_human_approval → done
```

- New records land in `intake`; the board lead triages them `ready`, `clarify` (a question for Alex) or keeps them in intake with a hold.
- A record can ask for a stronger worker: `model` (sonnet, opus, haiku) and `effort` (low to xhigh). The factory restarts the stream's worker with them before dispatch.
- A worker that gets stuck parks the job (`progress --stage blocked --waitingOn`). When the blocker clears, the factory sends "Resume".
- The internal review runs in the stream's own sandbox; nothing is posted to GitHub. A clean review marks the PR ready. Humans approve and merge.

## Alex's dashboard

- **Waiting on you**: the questions and cards that need Alex.
- **Sections**, by who the card waits on: Support, Needs you, Maybe mergeable, Waiting on other people, The factory has it (in lanes per stream), Parked, Done or closed.
- **Approvals** (the side panel): one click each.
  - Review threads to resolve. Codex threads Alex has already replied to resolve themselves.
  - New PRs no task asked for.
  - New Teamwork tasks. Agents propose them; only the factory creates them, on Alex's click.

## Config

`config.json` holds the streams and their workers (`routing.supervisors`), polling intervals, the seats `factory.mjs` manages, role mapping, the PR-ready and auto-dispatch switches, and the Sentry scout. Secrets come from teamwork-mini's `.env` and are never in this repo.

## Developing

```bash
node --test test/*.test.mjs   # with the sandbox off; Node 26, no dependencies
```

- **Red first.** Every fix starts with a test that fails for the reported reason.
- **Replay-safe.** A reducer change must leave existing state unchanged: fold a copy of `data/factory.db` before and after, and compare.
- **Restart after a change.** Restart the live server (`ctrl+c` in its pane, then the run command above), then wait for `curl 127.0.0.1:4848/api/board` to answer.
- **Commit and push** each fix to `main`, and note the commit on the record that asked for it.
- Board bugs come in as `kind: "factory"` records owned by the board developer.

Design notes and plans live in `~/Code/plans/software-factory-v2/` (start with `architecture.md`). Workflow rules for every seat are in `~/Code/CLAUDE.md`.
