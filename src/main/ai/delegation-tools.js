/**
 * Handing work on: to another agent, or to many hosts at once.
 *
 * Both are the same primitive underneath (see `delegateApiFor` in
 * index.js): a child conversation with a brief, waited on, its report
 * returned as this tool's result. What differs is who does the work and
 * where. The chain stops two levels deep, and a child is never allowed
 * more than its parent.
 *
 * Built by tools.js with its helpers, like the inventory tools.
 */

function build({ z, ok, fail }) {
    const api = (ctx) => (ctx?.delegate && typeof ctx.delegate.run === 'function' ? ctx.delegate : null);

    const shape = (outcome) => ({
        status: outcome.status,
        conversationId: outcome.conversationId,
        report: outcome.summary || '',
        ...(outcome.reason ? { reason: outcome.reason } : {}),
    });

    return [
        {
            name: 'delegate',
            title: 'Delegate to an agent',
            readOnly: false,
            description:
                'Hand a self-contained task to another agent (by name) or to a fresh conversation of your own, '
                + 'and wait for its report. The other agent works with its own memory, inventory and rules, '
                + 'which is the point: use it when a task belongs to a specialist the user set up. Write the '
                + 'brief as you would for a colleague: the goal, what is known, what a good result looks like, '
                + 'and what not to touch. Anything the child needs approved is put to the user on your '
                + 'conversation. Do not delegate what you can do in a few calls yourself.',
            shape: {
                brief: z.string().min(1).max(20000).describe('The task, complete in itself.'),
                agent: z.string().max(60).optional().describe('The name of the agent to hand it to. Omit for a fresh conversation of your own.'),
                title: z.string().max(120).optional().describe('A short name for the child conversation.'),
            },
            handler: async (input, ctx) => {
                const delegate = api(ctx);
                if (!delegate) return fail('Delegation is not available here.');
                const outcome = await delegate.run({ agent: input.agent || '', brief: input.brief, title: input.title || '' });
                if (outcome.error) return fail(outcome.error);
                return ok(shape(outcome));
            },
        },

        {
            name: 'fan_out',
            title: 'Run across hosts',
            readOnly: false,
            description:
                'Run the same task on several hosts at once: one child conversation per host, each pinned to '
                + 'its host and unable to reach any other, a few in parallel, and every report gathered here. '
                + 'Use it for "check X on all the web servers" rather than doing them one after another. The '
                + 'brief should say what to check or do on the host and what to report. Approvals come to the '
                + 'user on your conversation, one per host.',
            shape: {
                hostIds: z.array(z.string()).min(1).max(50).describe('The saved host ids, from list_hosts.'),
                brief: z.string().min(1).max(20000).describe('What to do on each host, and what to report back.'),
                title: z.string().max(120).optional().describe('A short name for the child conversations.'),
            },
            handler: async (input, ctx) => {
                const delegate = api(ctx);
                if (!delegate) return fail('Delegation is not available here.');
                const outcome = await delegate.fanOut({ hostIds: input.hostIds, brief: input.brief, title: input.title || '' });
                if (outcome.error) return fail(outcome.error);
                return ok({
                    hosts: outcome.results.length,
                    done: outcome.results.filter(entry => entry.status === 'done').length,
                    results: outcome.results.map(entry => ({ host: entry.host, hostId: entry.hostId, ...shape(entry) })),
                });
            },
        },

        {
            name: 'list_agents',
            title: 'List agents',
            readOnly: true,
            description: 'The agents set up in this app, by name, for delegate.',
            shape: {},
            handler: async (input, ctx) => {
                const delegate = api(ctx);
                if (!delegate) return fail('Delegation is not available here.');
                return ok({ agents: delegate.agents() });
            },
        },
    ];
}

module.exports = { build };
