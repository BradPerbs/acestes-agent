/**
 * The user's other computers, as the agent sees them: the Acestes installs in
 * this one's fleet (see src/main/fleet). The agent can list them, and hand one
 * a task, which runs there as a conversation of that computer's own agent and
 * shows here as a tab that mirrors it (see fleet/tasks.js).
 *
 * Built by tools.js with its helpers, like the delegation tools.
 */

function build({ z, ok, fail }) {
    const fleet = () => require('../fleet');

    return [
        {
            name: 'run_on_device',
            title: 'Run a task on another computer',
            readOnly: false,
            description:
                'Hand a task to another computer in the user\'s fleet (by its name from list_devices): an Acestes '
                + 'install on another PC or a Windows server. It runs there as a conversation of that computer\'s '
                + 'own agent, with Full access on that computer and its own files, apps and desktop, and it opens '
                + 'here as a tab the user can watch and type into. A computer with no AI agent of its own that works '
                + 'borrows the model of one that has one, so nothing needs setting up there first. Use it when the '
                + 'user asks for something to happen on a particular machine, or when the work needs that machine '
                + '(its desktop, its files, its network). Write the brief as you would for a colleague there: the '
                + 'goal, what is known, what a good result looks like, what not to touch. By default this waits for '
                + 'its first turn to end and returns what the agent there said.',
            shape: {
                device: z.string().min(1).max(120).describe('The computer, by the name list_devices shows (or its id).'),
                brief: z.string().min(1).max(20000).describe('The task, complete in itself.'),
                agent: z.string().max(120).optional().describe('An agent on that computer, by name. Leave it out for the one selected there.'),
                title: z.string().max(120).optional().describe('A short title for the tab.'),
                wait: z.boolean().optional().describe('Wait for its first turn to end and get the report back (default). False returns as soon as it has started.'),
                open: z.boolean().optional().describe('Open it here as a tab (default true).'),
            },
            handler: async (input, ctx) => {
                const status = fleet().status();
                if (status.appLocked) return fail('The app is locked, so the fleet is not connected.');
                if (!status.fleet) return fail('This computer is not in a fleet. The user adds computers under Settings, Devices.');
                const result = await fleet().runOnDevice({
                    device: input.device,
                    brief: input.brief,
                    agent: input.agent || '',
                    title: input.title || '',
                    agentId: ctx?.agentId || '',
                    near: ctx?.conversationId || '',
                    open: input.open !== false,
                    wait: input.wait !== false,
                });
                if (result.error) return fail(result.error);
                return ok(result);
            },
        },

        {
            name: 'list_devices',
            title: 'List the devices',
            readOnly: true,
            description:
                'The computers in the user\'s Acestes fleet: this one and the others they installed Acestes on '
                + '(other PCs, Windows servers reached by RDP), with whether each is online now, its OS, its '
                + 'Acestes version, its agents and the runtimes each has switched on, and whether it can drive '
                + 'its own desktop. Read this when the user names another machine, or asks for something to '
                + 'happen on a computer other than this one.',
            shape: {},
            handler: async () => {
                const status = fleet().status();
                if (status.appLocked) return fail('The app is locked, so the fleet is not connected.');
                if (!status.fleet) {
                    return ok({
                        inFleet: false,
                        note: 'This computer is not in a fleet. The user adds computers under Settings, Devices.',
                        devices: [],
                    });
                }
                return ok({
                    inFleet: true,
                    connection: status.connection.state,
                    devices: status.devices.map(device => ({
                        id: device.id,
                        name: device.name,
                        thisComputer: device.self,
                        online: device.online,
                        ...(device.self || device.online ? {} : { lastSeen: device.seenAt ? new Date(device.seenAt).toISOString() : 'never' }),
                        os: device.info?.os || '',
                        version: device.info?.version || '',
                        user: device.info?.user || '',
                        computerUse: Boolean(device.info?.computerUse),
                        takesTasks: device.info?.acceptsTasks !== false,
                        hostsRelay: Boolean(device.info?.hub),
                        agents: (device.info?.agents || []).map(agent => ({ name: agent.name, runtimes: agent.runtimes })),
                    })),
                });
            },
        },
    ];
}

module.exports = { build };
