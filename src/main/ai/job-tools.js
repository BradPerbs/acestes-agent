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
    const api = (ctx) => (ctx?.jobs && typeof ctx.jobs.create === 'function' ? ctx.jobs : null);

    return [
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
                const result = jobs.create({
                    name: input.name,
                    schedule,
                    prompt: input.prompt,
                    policy: { approvals: input.approvals || 'park', budget: input.budget || {} },
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
