// Teamwork reads, through the teamwork-mini MCP's client so there is one Teamwork client. Needs TEAMWORK_SITE and TEAMWORK_API_KEY.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TW_DIR = join(homedir(), 'Code/teamwork mini mcp');

const client = async () => {
  const { TeamworkClient } = await import(pathToFileURL(join(TW_DIR, 'dist/teamwork/client.js')));
  return new TeamworkClient({ site: process.env.TEAMWORK_SITE, apiKey: process.env.TEAMWORK_API_KEY });
};

/**
 * Each task's top-level ancestor, {id, name} (the task itself when it has no parent). `cache` (id → {name, parent})
 * outlives a call, so a parent is read once. An unreadable task is left out.
 */
export async function readTopParents(ids, cache = new Map()) {
  const tw = await client(), out = new Map();
  const node = async id => {
    if (!cache.has(id)) { const { task } = await tw.getTask(id); cache.set(id, { name: task.name, parent: task.parentTaskId ? String(task.parentTaskId) : null }); }
    return cache.get(id);
  };
  for (const id of ids) {
    try {
      let at = id, n = await node(at);
      for (let hops = 0; n.parent && hops < 10; hops++) { at = n.parent; n = await node(at); }
      out.set(id, { id: at, name: n.name });
    } catch {}
  }
  return out;
}

/** Alex's assigned tasks, projected. */
export async function readTasks() {
  const { TeamworkClient } = await import(pathToFileURL(join(TW_DIR, 'dist/teamwork/client.js')));
  const { projectTask } = await import(pathToFileURL(join(TW_DIR, 'dist/projections/task.js')));
  const tw = new TeamworkClient({ site: process.env.TEAMWORK_SITE, apiKey: process.env.TEAMWORK_API_KEY });
  const me = await tw.getCurrentUser();
  const { tasks, users } = await tw.listTasksAssignedTo(me.id);
  return tasks.map(t => projectTask(t, users));
}
