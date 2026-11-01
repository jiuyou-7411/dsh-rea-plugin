/**
 * Team state for the panel.
 *
 * Two sources, in order of preference:
 *
 *   1. The `agentTeams` service, read through `agents.currentInitiator()` while a
 *      tool call is in flight — that is the only place the current Agent is
 *      available, since the panel's HTTP routes run outside any agent context.
 *   2. The structured arguments of the team tools themselves. `spawn_teammate`
 *      and `team_task_create` carry their payload as arguments even though their
 *      results are prose, so the panel can always say what was asked for.
 *
 * Source 1 is authoritative but its row shape is not part of a public contract,
 * so everything is normalised defensively: a field that is not there is simply
 * not shown, and a service that throws degrades to source 2 rather than blanking
 * the page.
 */

/** Pick the first present key, so a renamed field degrades instead of breaking. */
function pick(row, keys, fallback = null) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function normalizeMember(row, index) {
  const name = pick(row, ['name', 'title', 'label', 'agentName'], `成员 ${index + 1}`);
  const status = pick(row, ['status', 'state', 'phase', 'fiberPhase'], 'unknown');
  return {
    name: String(name),
    description: String(pick(row, ['description', 'purpose', 'prompt'], '') ?? '').slice(0, 200),
    status: String(status),
    id: String(pick(row, ['id', 'agentId', 'sessionId'], '') ?? ''),
    isLead: Boolean(pick(row, ['isLead', 'lead', 'root'], false)),
  };
}

function normalizeTask(row, index) {
  const subject = pick(row, ['subject', 'title', 'name'], `任务 ${index + 1}`);
  return {
    subject: String(subject),
    description: String(pick(row, ['description', 'detail'], '') ?? '').slice(0, 300),
    status: String(pick(row, ['status', 'state', 'phase'], 'unknown')),
    owner: String(pick(row, ['owner', 'assignee', 'claimedBy', 'agent'], '') ?? ''),
    revision: pick(row, ['revision', 'rev'], null),
    blockedBy: Array.isArray(row?.blocked_by ?? row?.blockedBy)
      ? (row.blocked_by ?? row.blockedBy)
      : [],
    writeScopes: Array.isArray(row?.write_scopes ?? row?.writeScopes)
      ? (row.write_scopes ?? row.writeScopes)
      : [],
  };
}

/**
 * Build the team view.
 *
 * `getTeams` / `getAgents` return the live services or null — both are optional,
 * because the agent-team packages are experimental and may not be mounted.
 */
export function createTeamView({ getTeams, getAgents } = {}) {
  let snapshot = {
    available: false,
    reason: 'agentTeams 服务未挂载',
    members: [],
    tasks: [],
    updatedAt: null,
  };

  /**
   * Re-read the service. Must be called from inside a tool-call context, where
   * `currentInitiator()` resolves; elsewhere it returns the previous snapshot.
   */
  function refresh() {
    const teams = getTeams?.() ?? null;
    const agents = getAgents?.() ?? null;

    if (!teams) {
      snapshot = { ...snapshot, available: false, reason: 'agentTeams 服务未挂载' };
      return snapshot;
    }

    let agent = null;
    try {
      agent = agents?.currentInitiator?.() ?? null;
    } catch {
      agent = null;
    }

    if (!agent) {
      // No agent in scope: this is the panel's HTTP context, not a session.
      // Keep whatever was last observed rather than reporting "no team".
      return snapshot;
    }

    try {
      const membersRaw = teams.listMembers?.(agent) ?? [];
      const tasksRaw = teams.listTasks?.(agent) ?? [];

      snapshot = {
        available: true,
        reason: null,
        members: (Array.isArray(membersRaw) ? membersRaw : []).map(normalizeMember),
        tasks: (Array.isArray(tasksRaw) ? tasksRaw : []).map(normalizeTask),
        updatedAt: Date.now(),
      };
    } catch (error) {
      snapshot = {
        ...snapshot,
        available: false,
        reason: `读取团队状态失败：${error?.message ?? error}`,
      };
    }

    return snapshot;
  }

  return {
    refresh,
    snapshot: () => snapshot,
    /**
     * Record what a team tool was asked to do, for when the service is absent.
     * Arguments are structured even when results are prose.
     */
    observeArgs(name, args) {
      if (!args || typeof args !== 'object') return;
      if (name === 'spawn_teammate' && args.name) {
        if (!snapshot.members.some((m) => m.name === String(args.name))) {
          snapshot = {
            ...snapshot,
            members: [...snapshot.members, normalizeMember({
              name: args.name,
              description: args.description,
              status: 'spawned',
            }, snapshot.members.length)],
            updatedAt: Date.now(),
          };
        }
      }
      if (name === 'team_task_create' && args.subject) {
        if (!snapshot.tasks.some((t) => t.subject === String(args.subject))) {
          snapshot = {
            ...snapshot,
            tasks: [...snapshot.tasks, normalizeTask({
              subject: args.subject,
              description: args.description,
              status: 'created',
              blocked_by: args.blocked_by,
              write_scopes: args.write_scopes,
            }, snapshot.tasks.length)],
            updatedAt: Date.now(),
          };
        }
      }
    },
  };
}
