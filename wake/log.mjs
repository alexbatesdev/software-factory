// Shadow wake: writes what it would have typed to a JSONL file and touches no pane.
import { appendFileSync } from 'node:fs';
import { wakeText } from '../core/wake.mjs';

export const createLogWake = file => async w => { appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...w, text: wakeText(w) }) + '\n'); return { ok: true, logged: true }; };
