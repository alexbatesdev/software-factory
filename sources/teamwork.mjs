// Teamwork reads, through the teamwork-mini MCP's client so there is one Teamwork client. Needs TEAMWORK_SITE and TEAMWORK_API_KEY.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TW_DIR = join(homedir(), 'Code/teamwork mini mcp');

/** Alex's assigned tasks, projected. */
export async function readTasks() {
  const { TeamworkClient } = await import(pathToFileURL(join(TW_DIR, 'dist/teamwork/client.js')));
  const { projectTask } = await import(pathToFileURL(join(TW_DIR, 'dist/projections/task.js')));
  const tw = new TeamworkClient({ site: process.env.TEAMWORK_SITE, apiKey: process.env.TEAMWORK_API_KEY });
  const me = await tw.getCurrentUser();
  const { tasks, users } = await tw.listTasksAssignedTo(me.id);
  return tasks.map(t => projectTask(t, users));
}
