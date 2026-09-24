/**
 * agents — inspect and control background sub-agents.
 *
 * Reports are delivered automatically when a worker finishes, so the model does NOT
 * need to poll: polling in a loop would burn turns and tokens to learn something it
 * will be told anyway. This tool exists for the two cases where the model genuinely
 * needs control — "I cannot proceed until that finishes" (wait) and "that is no
 * longer worth paying for" (cancel) — plus a cheap look at what is in flight.
 */
const bg = require('../background');

function makeAgentsTool() {
  return {
    def: {
      type: 'function',
      function: {
        name: 'agents',
        description:
          'Check on background sub-agents. Actions: "list" (what is running and what has finished), '
          + '"wait" (block until everything in flight finishes — only when you cannot continue without it; '
          + 'reports arrive on their own otherwise), "cancel" (stop one by subId, or all of them). '
          + 'You do NOT need to poll: a finished agent is reported to you automatically.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'wait', 'cancel'] },
            subId: { type: 'string', description: 'For cancel: the agent to stop. Omit to cancel all.' },
            timeoutMs: { type: 'integer', description: 'For wait: give up after this long (default 300000).' },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    async run(args, ctx) {
      const sessionId = (ctx && ctx.session && ctx.session.id) || 'default';
      const action = args.action || 'list';

      if (action === 'list') {
        const s = bg.listAll(sessionId);
        return {
          action: 'list',
          running: s.running,
          completed: s.completed,
          note: s.running.length
            ? `${s.running.length} still running — their reports will reach you automatically; no need to poll.`
            : 'Nothing running.',
        };
      }

      if (action === 'wait') {
        const t = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 300000;
        const before = bg.runningCount(sessionId);
        if (!before) return { action: 'wait', waited: false, note: 'Nothing was running.' };
        const settled = await bg.waitForAll(sessionId, t);
        return {
          action: 'wait',
          waited: true,
          settled,
          note: settled
            ? `All ${before} agent(s) finished. Their reports are delivered on your next turn.`
            : `Timed out after ${Math.round(t / 1000)}s with ${bg.runningCount(sessionId)} still running.`,
        };
      }

      if (action === 'cancel') {
        if (args.subId) {
          const ok = bg.cancel(sessionId, String(args.subId));
          return { action: 'cancel', subId: args.subId, cancelled: ok, note: ok ? 'Cancelled.' : 'No such running agent.' };
        }
        const n = bg.cancelAll(sessionId);
        return { action: 'cancel', cancelled: n, note: `Cancelled ${n} running agent(s).` };
      }

      throw new Error(`agents: unknown action "${action}". Valid: list, wait, cancel.`);
    },
  };
}

module.exports = { makeAgentsTool };
