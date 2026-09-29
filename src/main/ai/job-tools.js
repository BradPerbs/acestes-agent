/**
 * The tools that let the agent schedule its own work.
 *
 * A job is a prompt on a schedule, run with nobody watching. The agent may
 * make one from a conversation with a person, within limits the jobs API
 * enforces: it lands in this agent's inventory, it gets the parking policy
 * unless the user chose otherwise, and a run that a job started cannot
 * make more jobs. Everything else about a job (its model, its delivery,
 * switching it off) is the user's, on the Jobs page.
 *
 * Built by tools.js with its helpers, like the inventory tools.
 */

function build({ z, ok, fail }) {
    const api = (ctx) => (ctx?.jobs && typeof ctx.jobs.create === 'function'
        ? {
            resolveModel: async () => ({ error: 'Model lookup is not available here.' }),
            listModels: async () => [],
            startTask: async () => ({ error: 'Background tasks are not available here.' }),
            ...ctx.jobs,
        }
        : null);

    /**
     * The runtime, model and effort a task is pinned to.
     *
     * The agent is meant to have read list_models and to pass the runtime
     * and the model value exactly as reported, in which case nothing here
     * guesses: the value is looked up in the live list and refused if it is
     * not there. The user's own words are the fallback, matched across the
     * runtimes, for an agent that skipped the list.
     */
    const pinFrom = async (jobs, input) => {
        if (!input.provider && !input.model && !input.effort) return { pinned: {} };

        if (input.provider) {
            const catalogs = await jobs.listModels();
            const catalog = catalogs.find(entry => entry.provider === input.provider);
            if (!catalog) {
                const on = catalogs.map(entry => entry.provider).join(', ') || 'none';
                return { error: `The runtime "${input.provider}" is not switched on for this agent. On: ${on}.` };
            }
            const rows = catalog.rows || [];
            let row = null;
            if (input.model) {
                row = rows.find(entry => entry.value === input.model || entry.resolved === input.model) || null;
                if (!row && rows.length > 0) {
                    return { error: `"${input.model}" is not a model list_models reports for ${input.provider}. Pass the value exactly as listed.` };
                }
            }
            const offered = Array.isArray(row?.effort) ? row.effort : [];
            let effort = input.effort || '';
            let note = '';
            if (effort && offered.length > 0 && !offered.includes(effort)) {
                note = `${row.label} does not offer "${effort}" effort; it offers ${offered.join(', ')}. The run uses the default.`;
                effort = '';
            }
            return {
                pinned: {
                    provider: input.provider,
                    // A runtime that reports no list takes the name as given.
                    ...(row ? { model: row.value } : (input.model ? { model: input.model } : {})),
                    ...(effort ? { effort } : {}),
                },
                note,
            };
        }

        const found = await jobs.resolveModel([input.model, input.effort].filter(Boolean).join(' '));
        if (found.error) {
            return { error: found.candidates?.length
                ? `${found.error} Closest: ${found.candidates.map(entry => `${entry.label} (${entry.provider})`).join(', ')}. Read list_models and pass provider and model exactly.`
                : `${found.error} Read list_models and pass provider and model exactly.` };
        }
        return {
            pinned: { provider: found.provider, model: found.model, ...(found.effort ? { effort: found.effort } : {}) },
            note: found.effortDropped
                ? `${found.label} does not offer "${found.effortDropped}" effort${found.effortOffered.length ? `; it offers ${found.effortOffered.join(', ')}` : ''}. The run uses the default.`
                : '',
        };
    };

    /** The policy an agent-made job gets: parked unless the user asked for more. */
    const policyFor = (input) => {
        if (input.approvals === 'read-only') return 'read-only';
        if (input.autonomous === true) return 'full';
        return 'park';
    };

    return [
        {
            name: 'list_models',
            title: 'List the models',
            readOnly: true,
            description:
                'The runtimes this agent has switched on and the models each one reports right now, with the '
                + 'effort levels each model takes. Read this before pinning a task or a job to a model, then pass '
                + 'the runtime as `provider` and the model `value` exactly as listed. The list is what the '
                + 'runtimes say on this machine today; never write a model name from memory.',
            shape: {},
            handler: async (input, ctx) => {
                const jobs = api(ctx);
                if (!jobs) return fail('The model list is not available here.');
                const catalogs = await jobs.listModels();
                return ok({
                    runtimes: catalogs.map(catalog => ({
                        provider: catalog.provider,
                        models: (catalog.rows || []).map(row => ({
                            value: row.value,
                            label: row.label,
                            ...(row.description ? { description: row.description } : {}),
                            efforts: Array.isArray(row.effort) ? row.effort : [],
                            ...(row.preferred ? { default: true } : {}),
                        })),
                    })),
                });
            },
        },

        {
            name: 'start_task',
            title: 'Start a background task',
            readOnly: false,
            description:
                'Start a task now, in the background, in a run of its own that keeps going after this '
                + 'conversation moves on. Use it when the user says "work on X in the background", or names '
                + 'a model or runtime to do it on ("using grok 4.6 xhigh", "with codex", "on fable"). To pin '
                + 'a model, read list_models first and pass `provider` and the model `value` exactly as it '
                + 'lists them. Write the task as a complete brief, with the goal and what a good result looks like. The '
                + 'run waits for the user before changing anything unless the user said to do it without '
                + 'asking, in which case pass autonomous: true. The result is delivered to the user and is on '
                + 'the Runs page.',
            shape: {
                task: z.string().min(1).max(20000).describe('The brief, complete in itself.'),
                title: z.string().max(120).optional().describe('A short name for the run. Defaults to the first line of the task.'),
                provider: z.string().max(40).optional().describe('The runtime, as list_models names it, e.g. "claude-code", "grok", "codex".'),
                model: z.string().max(120).optional().describe('With provider: the model value exactly as list_models lists it. Alone: the user\'s words, matched across runtimes as a fallback. Omit for the agent\'s default.'),
                effort: z.string().max(20).optional().describe('An effort level the model offers, from list_models.'),
                autonomous: z.boolean().optional().describe('Only when the user said to do it without asking: nothing waits for approval. The blocked list still applies.'),
                approvals: z.enum(['read-only']).optional().describe('read-only for a task that only reports.'),
                notify: z.boolean().optional().describe('Notify the user when it ends. Defaults to true.'),
                open: z.boolean().optional().describe('Show the run\'s conversation in a tab, so the user can watch it work.'),
                budget: z.object({
                    maxToolCalls: z.number().int().min(1).max(500).optional(),
                    maxCostUsd: z.number().min(0.01).max(100).optional(),
                    maxMinutes: z.number().int().min(1).max(600).optional(),
                }).optional().describe('Ceilings for the run.'),
            },
            handler: async (input, ctx) => {
                const jobs = api(ctx);
                if (!jobs) return fail('Background tasks are not available here.');

                const pin = await pinFrom(jobs, input);
                if (pin.error) return fail(pin.error);
                const { pinned, note = '' } = pin;

                const title = input.title || input.task.split('\n')[0].slice(0, 80);
                const result = await jobs.startTask({
                    name: title,
                    prompt: input.task,
                    ...pinned,
                    policy: { approvals: policyFor(input), budget: input.budget || {} },
                    delivery: { notify: input.notify !== false },
                });
                if (result.error) return fail(result.error);
                const shown = input.open && result.conversationId && typeof ctx.conversations?.open === 'function'
                    ? ctx.conversations.open({ conversationIds: [result.conversationId], focus: false })
                    : null;
                return ok({
                    started: true,
                    runId: result.runId,
                    conversationId: result.conversationId,
                    ...(shown ? { opened: Boolean(shown.opened) } : {}),
                    title,
                    runtime: pinned.provider || 'the agent\'s default',
                    model: pinned.model || 'the agent\'s default',
                    effort: pinned.effort || 'default',
                    approvals: policyFor(input),
                    ...(note ? { note } : {}),
                    hint: 'It is running in its own conversation; the user will be told when it ends, and can watch it on the Runs page.',
                });
            },
        },

        {
            name: 'schedule_job',
            title: 'Schedule a job',
            readOnly: false,
            description:
                'Create a job: a task you will run on a schedule without the user present. Give it a name, '
                + 'a schedule and the prompt you should follow when it fires. Schedules: "in 20m" (once), '
                + '"every 2h", a cron expression like "0 9 * * 1" with an optional timezone, or a heartbeat '
                + '(an interval with a local probe command that runs first; you are only woken if it prints '
                + 'something or fails). The run gets the parking policy by default: anything that changes a '
                + 'system waits for the user. Say "read-only" for a job that only reports. Only schedule what '
                + 'the user asked to have done on a schedule.',
            shape: {
                name: z.string().min(1).max(120).describe('A short name the user will see.'),
                schedule: z.string().min(1).max(200).describe('"in 20m", "every 2h", a cron expression, or an ISO date.'),
                prompt: z.string().min(1).max(20000).describe('What to do when the job fires, written as instructions to yourself.'),
                timezone: z.string().max(80).optional().describe('IANA timezone for a cron expression, e.g. Europe/Rome.'),
                approvals: z.enum(['read-only', 'park']).optional().describe('read-only reports only; park (default) waits for the user on a change.'),
                autonomous: z.boolean().optional().describe('Only when the user said the job should act without asking: nothing waits for approval. The blocked list still applies.'),
                provider: z.string().max(40).optional().describe('The runtime, as list_models names it.'),
                model: z.string().max(120).optional().describe('With provider: the model value exactly as list_models lists it. Alone: the user\'s words, matched across runtimes as a fallback. Omit for the agent\'s default.'),
                effort: z.string().max(20).optional().describe('An effort level the model offers, from list_models.'),
                probe: z.string().max(2000).optional().describe('For a heartbeat: a local command run first. Wakes you only if it prints something or exits non-zero. Print SKIP to stay quiet.'),
                notify: z.boolean().optional().describe('Whether the user gets a notification when a run ends. Defaults to true.'),
                budget: z.object({
                    maxToolCalls: z.number().int().min(1).max(500).optional(),
                    maxCostUsd: z.number().min(0.01).max(100).optional(),
                    maxMinutes: z.number().int().min(1).max(600).optional(),
                }).optional().describe('Ceilings for each run.'),
            },
            handler: async (input, ctx) => {
                const jobs = api(ctx);
                if (!jobs) return fail('Jobs are not available here.');
                let schedule = input.schedule;
                if (input.probe) {
                    const every = /^every\s+(.+)$/i.exec(String(schedule).trim());
                    if (!every) return fail('A heartbeat needs an "every ..." schedule.');
                    schedule = { kind: 'heartbeat', every: every[1], probe: { command: input.probe } };
                } else if (input.timezone && !/^(in|every|at)\s/i.test(String(schedule))) {
                    schedule = { kind: 'cron', expr: schedule, tz: input.timezone };
                }
                const pin = await pinFrom(jobs, input);
                if (pin.error) return fail(pin.error);
                const { pinned } = pin;
                const result = jobs.create({
                    name: input.name,
                    schedule,
                    prompt: input.prompt,
                    ...pinned,
                    policy: { approvals: policyFor(input), budget: input.budget || {} },
                    delivery: { notify: input.notify !== false },
                });
                if (result.error) return fail(result.error);
                return ok({
                    created: true,
                    id: result.job.id,
                    name: result.job.name,
                    schedule: result.job.scheduleText,
                    nextRunAt: result.job.nextRunAt ? new Date(result.job.nextRunAt).toISOString() : null,
                    approvals: result.job.policy.approvals,
                    ...(pinned.model ? { runtime: pinned.provider, model: pinned.model, effort: pinned.effort || 'default' } : {}),
                });
            },
        },

        {
            name: 'list_jobs',
            title: 'List jobs',
            readOnly: true,
            description: 'List the jobs in your inventory: their schedules, whether they are on, when they next run and how the last run went.',
            shape: {},
            handler: async (input, ctx) => {
                const jobs = api(ctx);
                if (!jobs) return fail('Jobs are not available here.');
                return ok({
                    jobs: jobs.list().map(job => ({
                        id: job.id,
                        name: job.name,
                        enabled: job.enabled,
                        schedule: job.scheduleText,
                        approvals: job.policy?.approvals,
                        nextRunAt: job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null,
                        lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
                        lastStatus: job.lastStatus || null,
                        failures: job.failures,
                        runs: job.runCount,
                        createdBy: job.createdBy,
                    })),
                });
            },
        },

        {
            name: 'update_job',
            title: 'Change a job',
            readOnly: false,
            description: 'Change a job in your inventory: switch it on or off, change its schedule or prompt, run it now, or delete it. Only on the user\'s say-so.',
            shape: {
                id: z.string().describe('The job id from list_jobs.'),
                action: z.enum(['enable', 'disable', 'run_now', 'delete', 'edit']).describe('What to do.'),
                schedule: z.string().max(200).optional().describe('For edit: a new schedule.'),
                prompt: z.string().max(20000).optional().describe('For edit: a new prompt.'),
                name: z.string().max(120).optional().describe('For edit: a new name.'),
            },
            handler: async (input, ctx) => {
                const jobs = api(ctx);
                if (!jobs) return fail('Jobs are not available here.');
                let result;
                switch (input.action) {
                    case 'enable': result = jobs.update(input.id, { enabled: true }); break;
                    case 'disable': result = jobs.update(input.id, { enabled: false }); break;
                    case 'delete': result = jobs.remove(input.id); break;
                    case 'run_now': result = await jobs.runNow(input.id); break;
                    case 'edit': {
                        const patch = {};
                        if (input.schedule !== undefined) patch.schedule = input.schedule;
                        if (input.prompt !== undefined) patch.prompt = input.prompt;
                        if (input.name !== undefined) patch.name = input.name;
                        result = jobs.update(input.id, patch);
                        break;
                    }
                    default: return fail(`Unknown action "${input.action}".`);
                }
                if (result?.error) return fail(result.error);
                return ok({ action: input.action, ...(result?.job ? { job: { id: result.job.id, name: result.job.name, enabled: result.job.enabled, schedule: result.job.scheduleText } } : result) });
            },
        },
    ];
}

module.exports = { build };
