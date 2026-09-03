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
        ? { resolveModel: async () => ({ error: 'Model lookup is not available here.' }), startTask: async () => ({ error: 'Background tasks are not available here.' }), ...ctx.jobs }
        : null);

    /** The policy an agent-made job gets: parked unless the user asked for more. */
    const policyFor = (input) => {
        if (input.approvals === 'read-only') return 'read-only';
        if (input.autonomous === true) return 'full';
        return 'park';
    };

    return [
        {
            name: 'start_task',
            title: 'Start a background task',
            readOnly: false,
            description:
                'Start a task now, in the background, in a run of its own that keeps going after this '
                + 'conversation moves on. Use it when the user says "work on X in the background", or names '
                + 'a model or runtime to do it on ("using grok 4.6 xhigh", "with codex", "on opus"). The model '
                + 'is looked up across the runtimes this agent has switched on; write it the way the user said '
                + 'it. Write the task as a complete brief, with the goal and what a good result looks like. The '
                + 'run waits for the user before changing anything unless the user said to do it without '
                + 'asking, in which case pass autonomous: true. The result is delivered to the user and is on '
                + 'the Runs page.',
            shape: {
                task: z.string().min(1).max(20000).describe('The brief, complete in itself.'),
                title: z.string().max(120).optional().describe('A short name for the run. Defaults to the first line of the task.'),
                model: z.string().max(120).optional().describe('The model and effort as the user named them, e.g. "grok 4.6 xhigh", "opus", "gpt-5 codex high". Omit for the agent\'s default.'),
                autonomous: z.boolean().optional().describe('Only when the user said to do it without asking: nothing waits for approval. The blocked list still applies.'),
                approvals: z.enum(['read-only']).optional().describe('read-only for a task that only reports.'),
                notify: z.boolean().optional().describe('Notify the user when it ends. Defaults to true.'),
                budget: z.object({
                    maxToolCalls: z.number().int().min(1).max(500).optional(),
                    maxCostUsd: z.number().min(0.01).max(100).optional(),
                    maxMinutes: z.number().int().min(1).max(600).optional(),
                }).optional().describe('Ceilings for the run.'),
            },
            handler: async (input, ctx) => {
                const jobs = api(ctx);
                if (!jobs) return fail('Background tasks are not available here.');

                let pinned = {};
                let note = '';
                if (input.model) {
                    const found = await jobs.resolveModel(input.model);
                    if (found.error) {
                        return fail(found.candidates?.length
                            ? `${found.error} Closest: ${found.candidates.map(entry => `${entry.label} (${entry.provider})`).join(', ')}.`
                            : found.error);
                    }
                    pinned = { provider: found.provider, model: found.model, effort: found.effort };
                    if (found.effortDropped) {
                        note = `${found.label} does not offer "${found.effortDropped}" effort${found.effortOffered.length ? `; it offers ${found.effortOffered.join(', ')}` : ''}. The run uses the default.`;
                    }
                }

                const title = input.title || input.task.split('\n')[0].slice(0, 80);
                const result = await jobs.startTask({
                    name: title,
                    prompt: input.task,
                    ...pinned,
                    policy: { approvals: policyFor(input), budget: input.budget || {} },
                    delivery: { notify: input.notify !== false },
                });
                if (result.error) return fail(result.error);
                return ok({
                    started: true,
                    runId: result.runId,
                    conversationId: result.conversationId,
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
                model: z.string().max(120).optional().describe('The model and effort to run on, as the user named them, e.g. "grok 4.6 xhigh". Omit for the agent\'s default.'),
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
                let pinned = {};
                if (input.model) {
                    const found = await jobs.resolveModel(input.model);
                    if (found.error) return fail(found.error);
                    pinned = { provider: found.provider, model: found.model, effort: found.effort };
                }
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
