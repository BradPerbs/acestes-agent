/**
 * Cloud sandboxes: a computer of the agent's own, on Spaceyard, for work that
 * should not happen on the user's desktop. These start, stop and pick one;
 * once one is picked, the computer tools (computer-tools.js) act on it rather
 * than on this computer. See spaceyard.js for how, and index.js for where the
 * choice is kept.
 *
 * Starting one costs money, and so does a command run on it, so both ask like
 * any change; listing and choosing which computer the tools aim at change
 * nothing, and do not. Offered only while the agent's "Cloud sandboxes"
 * switch is on (see visibleTools in tools.js).
 *
 * Built by tools.js with its helpers, like the computer tools.
 */

function build({ z, ok, fail }) {
    const run = async (ctx, method, input) => {
        const spaceyard = ctx?.spaceyard;
        if (!spaceyard || typeof spaceyard[method] !== 'function') return fail('Cloud sandboxes are not available here.');
        const result = await spaceyard[method](input || {});
        if (result.error) return fail(result.error);
        return ok(result);
    };

    const sandbox = z.string().min(1).max(64);

    const tools = [
        {
            name: 'list_sandboxes',
            title: 'List the cloud sandboxes',
            readOnly: true,
            description:
                'The user\'s Spaceyard sandboxes (cloud computers with a Linux or Windows desktop) with their status and '
                + 'price, which one this conversation\'s computer tools act on, and the images a new one can start from.',
            shape: {},
            handler: (input, ctx) => run(ctx, 'list', input),
        },

        {
            name: 'start_sandbox',
            title: 'Start a cloud sandbox',
            readOnly: false,
            description:
                'Start a Spaceyard sandbox, a cloud computer with a desktop, and point this conversation\'s computer tools '
                + '(read_screen, screenshot, click, type_text, press_keys, scroll, drag, do_steps, open_app...) at it '
                + 'instead of this computer. With sandbox, starts one that exists again (its disk as it was); without, '
                + 'makes a new one: Linux unless os or image says otherwise. Waits until its desktop answers, usually '
                + 'well under a minute. Use it when the user asks for a sandbox or a cloud computer, or for work that '
                + 'should not touch their own desktop. It is billed by the minute while it runs: stop_sandbox it when '
                + 'the work is done. To type a password there, give its keychain name in secrets, then type_text its '
                + '{{secret:name}} reference on its own.',
            shape: {
                sandbox: sandbox.optional().describe('An existing sandbox\'s id from list_sandboxes, to start again and use.'),
                os: z.enum(['linux', 'windows']).optional().describe('For a new one: its system. Defaults to linux.'),
                image: z.string().max(120).optional().describe('For a new one: an image by id, slug or name from list_sandboxes.'),
                name: z.string().max(60).optional().describe('For a new one: a name to know it by.'),
                secrets: z.array(z.string().min(1).max(60)).max(20).optional()
                    .describe('For a new one: keychain secret names to give it, encrypted, as its environment variables, '
                        + 'so type_text can type them there without the value passing through a request or a log.'),
                idleMinutes: z.number().int().min(5).max(43200).optional()
                    .describe('For a new one: stop it after this many minutes without use. Defaults to the agent\'s setting.'),
            },
            handler: (input, ctx) => run(ctx, 'start', input),
        },

        {
            name: 'stop_sandbox',
            title: 'Stop a cloud sandbox',
            readOnly: false,
            description:
                'Stop a Spaceyard sandbox, keeping its disk (billed at a small rate while stopped, and start_sandbox '
                + 'brings it back), or with destroy, remove it, disk and all, which cannot be undone. Without sandbox, '
                + 'the one this conversation is using; the computer tools then act on this computer again. Destroy '
                + 'one you made for a task once the task is done, unless the user wants to keep it.',
            shape: {
                sandbox: sandbox.optional().describe('Its id from list_sandboxes. Defaults to the one in use.'),
                destroy: z.boolean().optional().describe('Remove it for good, rather than stop it.'),
            },
            handler: (input, ctx) => run(ctx, 'stop', input),
        },

        {
            name: 'sandbox_command',
            title: 'Run a command in a cloud sandbox',
            readOnly: false,
            description:
                'Run a shell command on a Spaceyard sandbox and get its exit code and output: /bin/sh as root on Linux, '
                + 'PowerShell on Windows. Waits up to 60 seconds; a longer job keeps running there, so start one in the '
                + 'background with its output in a file. Quicker than the desktop for installing, downloading, reading '
                + 'files and checking what happened. Never touches this computer.',
            shape: {
                command: z.string().min(1).max(8000).describe('The command line.'),
                sandbox: sandbox.optional().describe('Its id from list_sandboxes. Defaults to the one in use.'),
            },
            handler: (input, ctx) => run(ctx, 'command', input),
        },

        {
            name: 'use_computer',
            title: 'Choose which computer to use',
            readOnly: true,
            description:
                'Point this conversation\'s computer tools at this computer ("this") or at a running Spaceyard sandbox '
                + '(its id from list_sandboxes). Changes nothing on either: it only says where the next read_screen, '
                + 'click or type_text goes. The choice is kept with the conversation until it is changed.',
            shape: {
                target: z.string().min(1).max(64).describe('"this" for this computer, or a sandbox\'s id.'),
            },
            handler: (input, ctx) => run(ctx, 'use', input),
        },
    ];

    return tools.map(tool => ({ ...tool, group: 'computer' }));
}

const NAMES = ['list_sandboxes', 'start_sandbox', 'stop_sandbox', 'sandbox_command', 'use_computer'];

module.exports = { build, NAMES };
