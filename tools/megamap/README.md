# Megamap

The software factory's GPU code map at `/megamap/`: a zoomable WebGL2 treemap,
filesystem sidebar, source inspection and definition navigation. Rust workers
provide scanning, layout, Git history, Ruby/JavaScript/TypeScript relationships,
syntax colors, PR comparisons and optional Rails evidence. This component has no
desktop window, native renderer or standalone web server.

Based on [Code Map](https://github.com/Peeter95/code-map).

## Build and test

Install Rust and a C compiler for the Tree-sitter grammars. The service uses Node
built-ins with no npm dependencies. Git is needed for repository scanning; PR
comparisons additionally use the installed `gh` CLI and its authentication.

From the factory repository root:

```sh
cargo build --manifest-path tools/megamap/Cargo.toml --release --locked --bins
cargo test --manifest-path tools/megamap/Cargo.toml --release --locked
node --test tools/megamap/web/*.test.mjs
ruby tools/megamap/tests/runtime_evidence_test.rb
```

The build creates `megamap-data` and `megamap-capture` under
`tools/megamap/target/release/`. Both are needed for optional live capture: the
second supervises the Rails child and stops it on timeout or viewer exit. No
Apple graphics SDK or desktop feature is required. Build output, Cargo registry
caches, Rust toolchains and private verification artifacts do not belong in git.

## Factory integration

The factory host imports `web/server.mjs` and calls:

```js
const handler = await createMegamapHandler({
  prefix: '/megamap',
  projects: [{ id: 'app', label: 'Application', root: trustedCheckout }],
  binary: builtAnalysisWorkerPath,
  allowCapture: false,
});
```

The host supplies the worker path explicitly and forwards requests to
`handler.handle(req, res)`; it calls `handler.close()` on shutdown. Project roots
come only from trusted configuration, never HTTP input. Loopback, same-origin and
request-token checks remain enforced. The service bounds workers and queues,
keeps separate immutable PR sessions, and closes its owned process groups.

## Browsing

Scroll to zoom, drag to pan, and select a file in the map or sidebar. At readable
zoom, source is rendered with optional syntax colors and colored call links.
Click a relationship call to open its definition. The footer info icon explains
map controls; toolbar controls have hover help. The pulsing Triforce marks pending
work. The tree and inspector remain usable if WebGL is unavailable.

Path filtering supports spaces for AND, `|` for OR, leading `-` to exclude and
wildcards such as `app/**/*.rb`. Hide tests removes test/spec files from the view.
Search highlights paths; Enter visits matches. Trace selected shows calls made or
callers up to the selected depth. Changing depth preserves the camera. Relationship
labels distinguish source resolution, inference, loaded metadata and exercised
execution. Git history colors show recent changes or change frequency.

Refresh / rescan reads checkout changes and clears old trace/evidence IDs.
Sources are bounded to 2 MiB previews and a 24-file/16-MiB browser cache. Show ignored
can read ignored entries on demand; it is off by default.

## PR changes and impact

Enter a PR number or use a factory card's changes link. The service reads exact
GitHub merge-base/head blobs into private snapshots without checking out or running
PR code. Full context dims unchanged files; Changed files only focuses edits;
Potential impact traces possible callers of changed methods. Select one changed
method or all changes, choose Before/After, and inspect diff excerpts and caller
witnesses. Before/After preserves geometry and camera; deleted definitions retain
before-side callers. Witness endpoints open their recorded revision and source line.

Reload PR rechecks metadata. Unchanged revisions reuse analyzed indices; changed
commits build a new index. Each session keeps its own side/filter/source state.
Analysis coverage warns about parse failures, unresolved calls, uncertain identities
and omitted files. PR snapshots cannot capture app evidence or expand ignored files.
Exit PR returns to checkout browsing.

Snapshots are bounded to 8 MiB per file, 512 MiB logical source total and a sampled
512 MiB fetched-object abort threshold. The service retains at most four workers
and sixteen PR sessions; evicted sessions can be reloaded. Symlinks, submodules and
oversized files are omitted explicitly. Source/diff previews are bounded.

## Optional Rails evidence

Static analysis works without Rails. Capture stays off unless the factory host
explicitly enables it. When enabled, Capture Rails metadata starts the registered
app's development `bin/rails runner` using the viewer process's Ruby environment.
Missing apps, capture failure or the 45-second Rails timeout fall back to source
analysis. No app code runs automatically or in immutable PR mode.

To export from the application's own environment, set
`MEGAMAP_EVIDENCE_MODE=snapshot` and `MEGAMAP_EVIDENCE_OUT` to an output path, then
run `bin/rails runner` with this component's `tools/runtime_evidence.rb`. Import
the resulting JSON using Snapshot. Captures contain source-relative metadata,
fingerprints and counts, not model arguments or values.

For observed execution, require that helper inside an already loaded app and wrap
an explicitly chosen development request or test in
`MegamapEvidence.capture(root: Rails.root, output: outputPath) { ... }`. Requiring
the helper alone is inert. Observations cover only exercised code; C/framework and
block frames are boundaries, and background-job causality is not invented.

New version 2 captures pool method definitions and keep compact per-class lookup
references. Aliases, inherited and generated methods retain effective targets.
The viewer also reads version 1 captures. Limits remain 50,000 unique definitions,
5,000 classes and 32 MiB exported JSON; incompleteness is warned. Changed Ruby source
context rejects stale captures and retains static analysis.
