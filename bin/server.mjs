#!/usr/bin/env node
// The factory's API server: node bin/server.mjs [--port 4848] [--db data/factory.db]
import http from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const db = arg('db', join(ROOT, 'data/factory.db'));
mkdirSync(dirname(db), { recursive: true });
const store = openStore(db, { supervisors: Object.keys(config.routing.supervisors) });
const port = Number(arg('port', 4848));
http.createServer(createApi({ store, config })).listen(port, '127.0.0.1', () => console.log(`software factory API on http://127.0.0.1:${port} (${db}, seq ${store.state.seq})`));
