// Teamwork reads, through the teamwork-mini MCP's client so there is one Teamwork client. Needs TEAMWORK_SITE and TEAMWORK_API_KEY.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripHtml } from '../core/observe.mjs';

const TW_DIR = join(homedir(), 'Code/repos/teamwork mini mcp');

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
  const lists = [...new Set(tasks.map(t => t.tasklistId).filter(Boolean))];
  const projectOf = new Map(lists.length ? (await tw.get(`/projects/api/v3/tasklists.json?ids=${lists.join(',')}&pageSize=500`)).tasklists.map(l => [l.id, l.projectId]) : []);
  return tasks.map(t => ({ ...projectTask(t, users), projectId: projectOf.get(t.tasklistId) ?? null }));
}

// Teamwork Sync's mirror of a GitHub event ("**login** submitted a review to the PR: ... github.com/.../pull/n"): GitHub is read directly.
const SYNC_NOTICE = /^\s*\*\*[\w-]+\*\* [\s\S]*?github\.com\/[^\s)]+\/pull\/\d+/;
/**
 * A task's feedback, newest last: comments from anyone but Alex, after his last comment on the task and after `since`.
 * Pure; ids are namespaced so they can't collide with GitHub ids in a finding's source.
 */
export function taskFeedback(taskId, comments, { me, since = '', site }) {
  const mine = comments.filter(c => c.postedByUserId === me).map(c => c.postedDateTime);
  const after = [since, ...mine].sort().at(-1) || '';
  return comments.filter(c => c.postedByUserId !== me && !c.deleted && c.postedDateTime > after && !SYNC_NOTICE.test(c.body || ''))
    .sort((a, b) => a.postedDateTime.localeCompare(b.postedDateTime))
    .map(c => ({ id: `tw-comment-${c.id}`, by: `teamwork user ${c.postedByUserId}`, url: `https://${site}/app/tasks/${taskId}?c=${c.id}`, text: stripHtml(c.body).replace(/\s+/g, ' ').slice(0, 1500) }));
}

/** taskId → its feedback (taskFeedback), for each of these tasks. An unreadable task is left out. */
export async function readTaskFeedback(ids, since) {
  const tw = await client(), me = (await tw.getCurrentUser()).id, out = new Map();
  for (const id of ids) {
    try { out.set(id, taskFeedback(id, (await tw.getTaskComments(id, { limit: 30 })).comments, { me, since, site: process.env.TEAMWORK_SITE })); } catch {}
  }
  return out;
}

/** W-382: the factory's only Teamwork write path, run on Alex's dashboard click. Needs teamwork-mini's createTask (its #1). */
export async function createTask(input) {
  const c = await client();
  if (typeof c.createTask !== 'function') throw new Error('teamwork-mini has no createTask yet: merge and build alexbatesdev/teamwork-mini-mcp#1');
  return c.createTask(input);
}
export const getTask = async id => (await (await client()).getTask(id))?.task ?? null;
/** The task of exactly this name in that tasklist (or under that parent), as {id, url}, or null. Guards a retried create (W-382). */
export async function findTask({ name, tasklistId, parentTaskId }) {
  const c = await client();
  const tasks = parentTaskId ? await c.listSubtasks(parentTaskId) : (await c.searchTasks(name, { pageSize: 100 })).tasks;
  const t = (tasks || []).find(x => x.name === name && (parentTaskId || x.tasklistId === tasklistId));
  return t ? { id: t.id, url: `https://${String(process.env.TEAMWORK_SITE).replace(/^https?:\/\//, '')}/app/tasks/${t.id}` } : null;
}
