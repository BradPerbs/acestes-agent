/**
 * Handing work on: to another agent, or to many hosts at once, and
 * conversations of the agent's own beside the one it is in.
 *
 * Delegation and fan-out are the same primitive underneath (see
 * `delegateApiFor` in index.js): a child conversation with a brief, waited
 * on, its report returned as this tool's result. What differs is who does
 * the work and where. The chain stops two levels deep, and a child is never
 * allowed more than its parent.
 *
 * The conversation tools are that primitive in the open (see
 * `conversationsApiFor`): a chat started or branched by the agent is a chat
 * like one the user starts, in a tab of its own, going on after this turn
 * unless the agent waits for it. Same depth, same policy.
 *
 * Built by tools.js with its helpers, like the inventory tools.
 */

function build({ z, ok, fail }) {
    const api = (ctx) => (ctx?.delegate && typeof ctx.delegate.run === 'function' ? ctx.delegate : null);
    const chats = (ctx) => (ctx?.conversations && typeof ctx.conversations.start === 'function' ? ctx.conversations : null);

    const shape = (outcome) => ({
        status: outcome.status,
        conversationId: outcome.conversationId,
        report: outcome.summary || '',
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.opened !== undefined ? { opened: outcome.opened } : {}),
    });

    const open = z.boolean().optional();
    const focus = z.boolean().optional()
        .describe('Bring the new tab to the front. Leave it off unless the user asked to be taken there: they are reading this one.');
    const wait = z.boolean().optional()
        .describe('Wait for its reply and get it back here as a report, like delegate. Otherwise it works on while you carry on.');

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
                open: open.describe('Show the child conversation in a tab while it works, so the user can watch it.'),
            },
            handler: async (input, ctx) => {
                const delegate = api(ctx);
                if (!delegate) return fail('Delegation is not available here.');
                const outcome = await delegate.run({
                    agent: input.agent || '',
                    brief: input.brief,
                    title: input.title || '',
                    open: input.open === true,
                });
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
                open: open.describe('Show each host\'s conversation in a tab of its own while it works. The first 12 only.'),
            },
            handler: async (input, ctx) => {
                const delegate = api(ctx);
                if (!delegate) return fail('Delegation is not available here.');
                const outcome = await delegate.fanOut({
                    hostIds: input.hostIds,
                    brief: input.brief,
                    title: input.title || '',
                    open: input.open === true,
                });
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

        {
            name: 'new_conversation',
            title: 'Start a conversation',
            readOnly: false,
            description:
                'Start a new conversation in a tab of its own, with you or with another agent by name, and '
                + 'send it a first message. It is an ordinary chat: the user can watch it, answer its questions '
                + 'and talk to it, and it goes on after your turn ends. Use it when the user asks for work in '
                + 'another tab or session, or for several lines of work side by side. It starts empty, so write '
                + 'the message as a complete brief. To carry this conversation over, use branch_conversation '
                + 'instead. Follow up with message_conversation and check_conversations.',
            shape: {
                message: z.string().min(1).max(20000).describe('The first message, complete in itself.'),
                agent: z.string().max(60).optional().describe('The name of the agent to start it with. Omit for yourself.'),
                title: z.string().max(120).optional().describe('A short name for its tab. Omit to have it named from the message.'),
                open: open.describe('Show it in a tab. Defaults to true.'),
                focus,
                wait,
            },
            handler: async (input, ctx) => {
                const conversations = chats(ctx);
                if (!conversations) return fail('Starting conversations is not available here.');
                const outcome = await conversations.start({
                    agent: input.agent || '',
                    message: input.message,
                    title: input.title || '',
                    open: input.open !== false,
                    focus: input.focus === true,
                    wait: input.wait === true,
                });
                return outcome.error ? fail(outcome.error) : ok(outcome);
            },
        },

        {
            name: 'branch_conversation',
            title: 'Branch a conversation',
            readOnly: false,
            description:
                'Fork a conversation into a new one that carries on from a point in it, with everything said '
                + 'up to there, in a tab of its own. This one by default, or an earlier one of yours by id (from '
                + 'search_conversations). Use it to try another approach without losing this one, to pick up an '
                + 'old conversation where it stopped, or when the user asks to fork or branch. With a message it '
                + 'starts working on it at once; without, it waits for the user.',
            shape: {
                conversationId: z.string().max(80).optional().describe('The conversation to branch. Omit for this one.'),
                turn: z.number().int().optional().describe(
                    'Branch after this turn: 1 is the first message and what came of it, -1 the latest, -2 the one '
                    + 'before. Omit for everything so far.',
                ),
                message: z.string().max(20000).optional().describe('What the branch should do next. Omit to leave it for the user.'),
                title: z.string().max(120).optional().describe('A short name for its tab. Defaults to the original\'s.'),
                open: open.describe('Show it in a tab. Defaults to true.'),
                focus,
                wait: wait.describe('With a message: wait for its reply and get it back here as a report.'),
            },
            handler: async (input, ctx) => {
                const conversations = chats(ctx);
                if (!conversations) return fail('Branching conversations is not available here.');
                if (input.wait && !input.message) return fail('There is nothing to wait for without a message.');
                const outcome = await conversations.branch({
                    conversationId: input.conversationId || '',
                    turn: input.turn || 0,
                    message: input.message || '',
                    title: input.title || '',
                    open: input.open !== false,
                    focus: input.focus === true,
                    wait: input.wait === true,
                });
                return outcome.error ? fail(outcome.error) : ok(outcome);
            },
        },

        {
            name: 'open_conversation',
            title: 'Open a conversation',
            readOnly: true,
            description:
                'Show conversations in tabs: earlier ones of yours (by id, from search_conversations), or ones '
                + 'you started or delegated to. Already open, a tab is only brought forward when focus is set. '
                + 'Use it when the user asks to see a conversation, or to put one you started back on screen.',
            shape: {
                conversationIds: z.array(z.string().min(1).max(80)).min(1).max(12).describe('The conversations to open.'),
                focus: z.boolean().optional().describe('Bring the first to the front. Defaults to true; false opens them behind the tab being read.'),
            },
            handler: async (input, ctx) => {
                const conversations = chats(ctx);
                if (!conversations) return fail('Opening conversations is not available here.');
                const outcome = conversations.open({ conversationIds: input.conversationIds, focus: input.focus !== false });
                if (outcome.error) return fail(outcome.error);
                if (!outcome.opened) return fail(outcome.reason || 'It could not be opened.');
                return ok(outcome);
            },
        },

        {
            name: 'message_conversation',
            title: 'Message a conversation',
            readOnly: false,
            description:
                'Send a follow-up to a conversation you started, branched or delegated to from this one: more '
                + 'to do, a correction, an answer it asked you for. Not while it is still working on the last '
                + 'message; check_conversations says which are.',
            shape: {
                conversationId: z.string().min(1).max(80).describe('The conversation, as new_conversation or check_conversations gave it.'),
                message: z.string().min(1).max(20000).describe('The message.'),
                wait,
            },
            handler: async (input, ctx) => {
                const conversations = chats(ctx);
                if (!conversations) return fail('Messaging conversations is not available here.');
                const outcome = await conversations.message({
                    conversationId: input.conversationId,
                    message: input.message,
                    wait: input.wait === true,
                });
                return outcome.error ? fail(outcome.error) : ok(outcome);
            },
        },

        {
            name: 'check_conversations',
            title: 'Check on conversations',
            readOnly: true,
            description:
                'The conversations you started, branched or delegated to from this one: whether each is still '
                + 'working, whether it is in a tab, and its latest reply. Pass waitFor to wait for that one to finish, '
                + 'for a minute at most: past that you get how far it has got. You rarely need to wait at all, since '
                + 'a conversation you started reports to this one by itself when it finishes. Use read_conversation '
                + 'for one in full.',
            shape: {
                waitFor: z.string().max(80).optional().describe('A conversation to wait for, up to a minute.'),
            },
            handler: async (input, ctx) => {
                const conversations = chats(ctx);
                if (!conversations) return fail('Checking conversations is not available here.');
                const outcome = await conversations.check({ waitFor: input.waitFor || '' });
                return outcome.error ? fail(outcome.error) : ok(outcome);
            },
        },
    ];
}

module.exports = { build };
