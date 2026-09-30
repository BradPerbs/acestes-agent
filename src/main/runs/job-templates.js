const jobs = require('./jobs');

/**
 * The job library: work worth doing on a schedule, ready to switch on.
 *
 * Each template is a job with the blanks left in: a schedule, a policy, a
 * brief written the way a good job prompt reads (what to look at, how to
 * reach it, what the report looks like, and what not to touch), and the
 * few fields a person has to fill in (a repository, a host, a threshold).
 * `instantiate` fills them and hands back a job spec for jobs.create, the
 * same shape the Jobs page sends, so a template never becomes anything a
 * hand-made job could not be.
 *
 * Most are read-only on purpose. A report that runs at 9 every morning with
 * nobody watching should look, not touch; the ones that may change
 * something park on it and wait for the person.
 *
 * A field is `{ key, label, type, required, placeholder, default, help }`:
 *   text     put in as typed wherever `{{key}}` appears
 *   number   the same, checked to be a number
 *   url      the same, checked to be an http(s) address with nothing in it
 *            a shell would read, since a heartbeat's probe carries it
 *   time     "HH:MM", which becomes the minute and hour of the cron schedule
 *   host     a host's name, or '' for every host, or '@local' for this
 *            computer (offered when the field says `local`); `{{key}}`
 *            becomes a noun phrase naming it for the agent
 */

const CATEGORIES = ['code', 'servers', 'security', 'web', 'files', 'reports'];

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** How to reach GitHub, said once and put into every GitHub brief. */
const GITHUB_ACCESS = [
    'Reach GitHub with whichever of these works, in this order: the GitHub MCP tools if you have them;',
    'the GitHub CLI on this computer (`gh`, through run_local_command); the REST API at https://api.github.com',
    'with curl (without a token it sees only public repositories and allows 60 calls an hour). If none works,',
    'say exactly what is missing (for example "gh is not installed" or "gh is not logged in: run `gh auth login`")',
    'and stop there.',
].join(' ');

const REPORT_STYLE = 'Write the report for someone reading it on a phone: the verdict in the first line, then short sections, links where there are links. When there is nothing to report, say so in one line and stop.';

const HOST_ACCESS = 'Use list_hosts to find the hosts and connect_host and run_command to reach them. Work out each host\'s OS first and use the commands that fit it. A host you cannot reach is a finding: name it and say why, then carry on with the rest.';

const TEMPLATES = [
    /* ---------------- Code ---------------- */
    {
        id: 'github-open-issues',
        name: 'GitHub open issues',
        category: 'code',
        description: 'Every morning: what is open, what came in since yesterday, what nobody has picked up, and what is going stale.',
        needs: 'gh, the GitHub MCP server, or a public repository',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        approvals: 'read-only',
        budget: { maxToolCalls: 30, maxMinutes: 15 },
        fields: [
            { key: 'repo', label: 'Repository', type: 'text', required: true, placeholder: 'owner/name', help: 'As it appears in the URL: github.com/owner/name.' },
            { key: 'time', label: 'Time', type: 'time', default: '09:00' },
        ],
        prompt: `Report on the open issues in the GitHub repository {{repo}}.

${GITHUB_ACCESS}

With gh: \`gh issue list --repo {{repo}} --state open --limit 300 --json number,title,author,labels,assignees,comments,createdAt,updatedAt,url\`, and for what closed since yesterday \`gh issue list --repo {{repo}} --state closed --search "closed:>=YYYY-MM-DD" --json number,title,url\` with yesterday's date.
With the REST API: GET /repos/{{repo}}/issues?state=open&per_page=100, following the Link header for further pages, and dropping every entry that has a \`pull_request\` key (those are pull requests).

The report:
1. One line first: how many issues are open, how many were opened and how many closed in the last 24 hours.
2. New in the last 24 hours: number, title, author, labels, link.
3. Needs attention: open issues with no label, no assignee, or no reply from anyone but the author. Put bugs, and anything labelled security, critical, urgent, P0 or P1, first.
4. Going stale: open issues with no activity for 30 days or more, oldest first, at most ten.
5. Open issues counted by label.

${REPORT_STYLE} Do not comment on, label, assign, close or edit anything: this job only reports.`,
    },
    {
        id: 'github-pull-requests',
        name: 'Pull requests waiting on review',
        category: 'code',
        description: 'Each weekday: open pull requests, who they wait on, which are failing checks, and which have sat too long.',
        needs: 'gh, the GitHub MCP server, or a public repository',
        schedule: { kind: 'cron', expr: '30 9 * * 1-5' },
        approvals: 'read-only',
        budget: { maxToolCalls: 30, maxMinutes: 15 },
        fields: [
            { key: 'repo', label: 'Repository', type: 'text', required: true, placeholder: 'owner/name' },
            { key: 'days', label: 'Stale after (days)', type: 'number', default: '3', help: 'A pull request with no review activity for this long is called out.' },
            { key: 'time', label: 'Time', type: 'time', default: '09:30' },
        ],
        prompt: `Report on the open pull requests in the GitHub repository {{repo}}.

${GITHUB_ACCESS}

With gh: \`gh pr list --repo {{repo}} --state open --limit 100 --json number,title,author,isDraft,reviewDecision,reviewRequests,statusCheckRollup,createdAt,updatedAt,url,mergeable\`.
With the REST API: GET /repos/{{repo}}/pulls?state=open&per_page=100, then /pulls/{number}/reviews and /commits/{sha}/check-runs for the ones that need it.

Leave drafts out of everything except the count. The report:
1. One line first: how many are open (and how many of those are drafts), how many are ready to merge.
2. Waiting on review: who each is waiting on and for how long, longest first.
3. Blocked: failing checks (name the failing check), merge conflicts, or changes requested and not yet answered.
4. Stale: no review activity for {{days}} days or more.
5. Ready to merge: approved, checks green, no conflicts.

${REPORT_STYLE} Do not review, comment, approve, merge or close anything: this job only reports.`,
    },
    {
        id: 'github-failed-workflows',
        name: 'Failed CI runs',
        category: 'code',
        description: 'Every morning: the GitHub Actions runs that failed in the last day, with the log lines that explain why.',
        needs: 'gh or the GitHub MCP server',
        schedule: { kind: 'cron', expr: '30 8 * * *' },
        approvals: 'read-only',
        budget: { maxToolCalls: 40, maxMinutes: 20 },
        fields: [
            { key: 'repo', label: 'Repository', type: 'text', required: true, placeholder: 'owner/name' },
            { key: 'time', label: 'Time', type: 'time', default: '08:30' },
        ],
        prompt: `Report on the GitHub Actions runs in {{repo}} that failed in the last 24 hours.

${GITHUB_ACCESS}

With gh: \`gh run list --repo {{repo}} --status failure --limit 50 --json databaseId,workflowName,headBranch,event,createdAt,url,displayTitle\`, keeping the ones from the last 24 hours. For each failing workflow, read the failure with \`gh run view <id> --repo {{repo}} --log-failed\` and keep only the last forty lines or so that show the error.
With the REST API: GET /repos/{{repo}}/actions/runs?status=failure&created=>=YYYY-MM-DD, and the job logs from /actions/jobs/{job_id}/logs.

The report:
1. One line first: how many runs failed, and whether the default branch is currently red.
2. For each failing workflow (grouped, not one entry per run): the branch, how many times it failed, the step that fails, the error in two or three lines, and your best reading of the cause: a flaky test, a real regression, an infrastructure or credentials problem, or a dependency.
3. Anything that has been failing for more than a day on the default branch, called out on its own.

${REPORT_STYLE} Do not re-run, cancel or change anything: this job only reports.`,
    },
    {
        id: 'github-security-alerts',
        name: 'Dependabot and security alerts',
        category: 'code',
        description: 'Every Monday: open Dependabot, code scanning and secret scanning alerts, worst first.',
        needs: 'gh logged in with access to the repository\'s security alerts',
        schedule: { kind: 'cron', expr: '0 9 * * 1' },
        approvals: 'read-only',
        budget: { maxToolCalls: 25, maxMinutes: 15 },
        fields: [
            { key: 'repo', label: 'Repository', type: 'text', required: true, placeholder: 'owner/name' },
            { key: 'time', label: 'Time', type: 'time', default: '09:00' },
        ],
        prompt: `Report on the open security alerts in the GitHub repository {{repo}}.

${GITHUB_ACCESS}

With gh: \`gh api "repos/{{repo}}/dependabot/alerts?state=open&per_page=100" --paginate\`, \`gh api "repos/{{repo}}/code-scanning/alerts?state=open&per_page=100" --paginate\` and \`gh api "repos/{{repo}}/secret-scanning/alerts?state=open&per_page=100" --paginate\`. A 403 or 404 on one of them usually means the feature is off for the repository or the token lacks the security_events scope: say which, and carry on with the others.

The report:
1. One line first: open alerts by severity (critical, high, medium, low).
2. Critical and high: the package or rule, the affected version and the fixed one, the advisory link, and how long it has been open.
3. Secret scanning: any open alert, always, whatever its age. These are the urgent ones.
4. What changed since last week, if you can tell from the dates: new alerts, and alerts fixed.

${REPORT_STYLE} Do not dismiss alerts, open pull requests or change anything: this job only reports.`,
    },
    {
        id: 'github-releases',
        name: 'New releases of a project',
        category: 'code',
        description: 'Every day: a short note when a project you depend on publishes a release, with what changed that matters.',
        needs: 'gh, the GitHub MCP server, or a public repository',
        schedule: { kind: 'cron', expr: '0 10 * * *' },
        approvals: 'read-only',
        budget: { maxToolCalls: 10, maxMinutes: 10 },
        fields: [
            { key: 'repo', label: 'Project', type: 'text', required: true, placeholder: 'nginx/nginx', help: 'The GitHub repository whose releases to watch.' },
            { key: 'time', label: 'Time', type: 'time', default: '10:00' },
        ],
        prompt: `Check whether the GitHub project {{repo}} published a release in the last 24 hours.

${GITHUB_ACCESS}

With gh: \`gh release list --repo {{repo}} --limit 5 --json tagName,name,publishedAt,isPrerelease,isLatest\`, then \`gh release view <tag> --repo {{repo}}\` for a new one.
With the REST API: GET /repos/{{repo}}/releases?per_page=5.

If nothing was published in the last 24 hours, reply with one line saying so and stop. If something was: the version, whether it is a pre-release, and the release notes boiled down to what an operator cares about: security fixes (with CVE numbers), breaking changes, deprecations, and upgrade steps. Leave out routine fixes. Do not change anything.`,
    },

    /* ---------------- Servers ---------------- */
    {
        id: 'disk-space',
        name: 'Disk space check',
        category: 'servers',
        description: 'Every morning: any filesystem over the threshold, and what is filling it.',
        needs: 'Hosts in the inventory',
        schedule: { kind: 'cron', expr: '0 8 * * *' },
        approvals: 'read-only',
        budget: { maxToolCalls: 60, maxMinutes: 20 },
        fields: [
            { key: 'hosts', label: 'Hosts', type: 'host' },
            { key: 'threshold', label: 'Warn at (% used)', type: 'number', default: '85' },
            { key: 'time', label: 'Time', type: 'time', default: '08:00' },
        ],
        prompt: `Check disk usage on {{hosts}}.

${HOST_ACCESS}

On Linux and macOS use \`df -hP\` and \`df -iP\` (inodes run out too); on Windows use \`Get-Volume\` or \`Get-PSDrive -PSProvider FileSystem\`. Skip pseudo filesystems (tmpfs, devtmpfs, overlay, squashfs, snaps).

For every filesystem at or above {{threshold}}% used, in space or in inodes: find what is filling it, e.g. \`du -xh --max-depth=2 <mount> 2>/dev/null | sort -h | tail -15\` on Linux, and name the usual suspects if you see them (old logs, journal size, docker images and volumes, core dumps, package caches, old kernels). Say what could be freed and how, as commands, without running them.

The report: a verdict line first, then one section per host that is over the threshold, then a one-line list of the hosts that are fine. Do not delete, compress or move anything.`,
    },
    {
        id: 'failed-services',
        name: 'Failed services and errors',
        category: 'servers',
        description: 'Every morning: services that are down and the errors the logs picked up overnight.',
        needs: 'Hosts in the inventory',
        schedule: { kind: 'cron', expr: '30 7 * * *' },
        approvals: 'read-only',
        budget: { maxToolCalls: 60, maxMinutes: 20 },
        fields: [
            { key: 'hosts', label: 'Hosts', type: 'host' },
            { key: 'time', label: 'Time', type: 'time', default: '07:30' },
        ],
        prompt: `Look for failed services and new errors on {{hosts}}, over the last 24 hours.

${HOST_ACCESS}

On Linux with systemd: \`systemctl --failed --no-legend\`, then \`journalctl -p err --since "24 hours ago" --no-pager | tail -100\`, grouping repeated messages and counting them. Also note an OOM kill (\`journalctl -k --since "24 hours ago" | grep -i "out of memory"\`) or an unexpected reboot (\`last -x reboot | head -3\`).
On Windows: services set to start automatically that are not running (\`Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'"\`), and errors from the System and Application logs in the last day (\`Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1,2; StartTime=(Get-Date).AddDays(-1)}\`), grouped by source.

The report: a verdict line first, then per host: failed services with the last lines of their log, and the errors that matter, grouped and counted. Leave out known noise and say you did. Do not restart or change anything.`,
    },
    {
        id: 'pending-updates',
        name: 'Pending updates and reboots',
        category: 'servers',
        description: 'Every Monday: which hosts have updates waiting, which are security fixes, and which need a reboot.',
        needs: 'Hosts in the inventory',
        schedule: { kind: 'cron', expr: '0 8 * * 1' },
        approvals: 'read-only',
        budget: { maxToolCalls: 60, maxMinutes: 25 },
        fields: [
            { key: 'hosts', label: 'Hosts', type: 'host' },
            { key: 'time', label: 'Time', type: 'time', default: '08:00' },
        ],
        prompt: `Report the pending updates and reboots on {{hosts}}.

${HOST_ACCESS}

Debian and Ubuntu: \`apt list --upgradable 2>/dev/null\` (read the package lists as they are; do not run apt update unless the lists are more than a week old, and then say so), security updates among them, and \`/var/run/reboot-required\`.
RHEL, Fedora, Rocky, Alma: \`dnf check-update --security\` and \`dnf needs-restarting -r\`.
Alpine: \`apk version -l '<'\`. macOS: \`softwareupdate -l\`.
Windows: the pending reboot keys (Component Based Servicing\\RebootPending, WindowsUpdate\\Auto Update\\RebootRequired) and the last installed hotfix (\`Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 3\`).
Also note the kernel running against the newest installed one, and uptime.

The report: a verdict line first, then a table with host, OS, pending updates (security in brackets), reboot needed, uptime. Then the security updates by name for the hosts that have them. Do not install anything or reboot.`,
    },
    {
        id: 'container-health',
        name: 'Container health',
        category: 'servers',
        description: 'Twice a day: containers that are restarting, unhealthy or exited when they should be up.',
        needs: 'Hosts running Docker or Podman',
        schedule: { kind: 'cron', expr: '0 8,18 * * *' },
        approvals: 'read-only',
        budget: { maxToolCalls: 40, maxMinutes: 15 },
        fields: [
            { key: 'hosts', label: 'Hosts', type: 'host' },
        ],
        prompt: `Check container health on {{hosts}}.

${HOST_ACCESS}

Use docker, or podman where there is no docker. \`docker ps -a --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}\\t{{.RunningFor}}'\`, then for anything unhealthy, restarting, or exited with a non-zero code: \`docker inspect --format '{{.RestartCount}} {{.State.ExitCode}} {{.State.OOMKilled}}' <name>\` and the last 30 lines of \`docker logs --tail 30 <name>\`. Also note disk used by images and volumes (\`docker system df\`) when it is over 20 GB.

A host with no container runtime is not a finding; list it at the end in one line. The report: a verdict line first, then the containers in trouble with the reason in a line or two each. Do not restart, remove or prune anything.`,
    },
    {
        id: 'weekly-health',
        name: 'Weekly health report',
        category: 'reports',
        description: 'Every Monday: one table of every host, with uptime, load, memory, disk and OS, and what stands out.',
        needs: 'Hosts in the inventory',
        schedule: { kind: 'cron', expr: '0 8 * * 1' },
        approvals: 'read-only',
        budget: { maxToolCalls: 80, maxMinutes: 30 },
        fields: [
            { key: 'hosts', label: 'Hosts', type: 'host' },
            { key: 'time', label: 'Time', type: 'time', default: '08:00' },
        ],
        prompt: `Write the weekly health report for {{hosts}}.

${HOST_ACCESS}

For each host gather: OS and version, kernel, uptime and last reboot, load average against CPU count, memory and swap in use, the fullest filesystem, the top three processes by memory, and the time the clock is off by if it is more than a few seconds (NTP). Use \`recall\` to find what you saved last week under "weekly health", compare, and call out what moved: a disk that grew more than 10 points, a host that rebooted, memory that crept up. Then \`remember\` this week's figures under "weekly health" for next time, one short line per host.

The report: what stands out first (at most five points), then one table with a row per host. Do not change anything.`,
    },
    {
        id: 'morning-briefing',
        name: 'Morning IT briefing',
        category: 'reports',
        description: 'Each weekday before work: is everything up, and is anything about to become a problem today.',
        needs: 'Hosts in the inventory',
        schedule: { kind: 'cron', expr: '0 8 * * 1-5' },
        approvals: 'read-only',
        budget: { maxToolCalls: 80, maxMinutes: 25 },
        fields: [
            { key: 'hosts', label: 'Hosts', type: 'host' },
            { key: 'time', label: 'Time', type: 'time', default: '08:00' },
        ],
        prompt: `Write this morning's IT briefing for {{hosts}}.

${HOST_ACCESS}

Check, quickly and on every host: that it answers, failed services, filesystems over 90%, a reboot pending or an unexpected reboot overnight, memory or swap under pressure, and errors in the last twelve hours of logs that are not routine noise.

The briefing, in this order: one line saying whether everything is fine; then what needs doing today, most urgent first, each with the host and the one command or step that would deal with it; then what to keep an eye on. Leave out every host that is fine except for a count. Keep it under twenty lines. Do not change anything.`,
    },

    /* ---------------- Security ---------------- */
    {
        id: 'tls-certificates',
        name: 'TLS certificate expiry',
        category: 'security',
        description: 'Every Monday: the certificates on your sites, and any that expire soon or do not match their name.',
        needs: 'Nothing: checked from this computer',
        schedule: { kind: 'cron', expr: '0 9 * * 1' },
        approvals: 'read-only',
        budget: { maxToolCalls: 30, maxMinutes: 10 },
        fields: [
            { key: 'domains', label: 'Sites', type: 'text', required: true, placeholder: 'example.com, api.example.com:8443', help: 'Separated by commas. Port 443 unless one is given.' },
            { key: 'days', label: 'Warn when fewer days left than', type: 'number', default: '21' },
            { key: 'time', label: 'Time', type: 'time', default: '09:00' },
        ],
        prompt: `Check the TLS certificates served by these sites: {{domains}}.

Check from this computer with run_local_command. Use openssl if it is there (\`openssl s_client -connect <host>:<port> -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -enddate -ext subjectAltName\`); on Windows without openssl, PowerShell can do it with a TcpClient and an SslStream, reading the remote certificate's NotAfter, Subject, Issuer and DNS names.

For each site: the days left, the issuer, whether the name matches, and whether the chain is trusted. A site that does not answer is a finding.

The report: a verdict line first; then every certificate with fewer than {{days}} days left, or a name mismatch, or an untrusted chain, as its own entry; then the rest in one short table sorted by days left. Do not change anything.`,
    },
    {
        id: 'failed-logins',
        name: 'Failed login attempts',
        category: 'security',
        description: 'Every morning: failed SSH and Windows logons in the last day, who they came from, and anything that got in.',
        needs: 'Hosts in the inventory',
        schedule: { kind: 'cron', expr: '0 7 * * *' },
        approvals: 'read-only',
        budget: { maxToolCalls: 50, maxMinutes: 20 },
        fields: [
            { key: 'hosts', label: 'Hosts', type: 'host' },
            { key: 'time', label: 'Time', type: 'time', default: '07:00' },
        ],
        prompt: `Review the login attempts on {{hosts}} over the last 24 hours.

${HOST_ACCESS}

Linux: \`journalctl -u ssh -u sshd --since "24 hours ago" --no-pager\` (or /var/log/auth.log or /var/log/secure where there is no journal). Count "Failed password", "Invalid user" and "authentication failure" by source address and by user, and list the successful logins ("Accepted") with user, source and method. \`lastb | head\` if it is readable.
Windows: events 4625 (failed) and 4624 with logon type 10 or 3 (successful remote) from the Security log in the last day, grouped by account and source address.

What matters: a successful login from an address that also failed many times, a login as root or an administrator from somewhere new, a password login where keys are expected, and a burst against one account. The report: a verdict line first, then those, then the top five sources of failures per host in one line each. Do not block, ban or change anything; say what you would do instead.`,
    },
    {
        id: 'listening-ports',
        name: 'Listening ports audit',
        category: 'security',
        description: 'Every Monday: what is listening on each host, and what changed since last week.',
        needs: 'Hosts in the inventory',
        schedule: { kind: 'cron', expr: '0 9 * * 1' },
        approvals: 'read-only',
        budget: { maxToolCalls: 50, maxMinutes: 20 },
        fields: [
            { key: 'hosts', label: 'Hosts', type: 'host' },
            { key: 'time', label: 'Time', type: 'time', default: '09:00' },
        ],
        prompt: `Audit the listening ports on {{hosts}}.

${HOST_ACCESS}

Linux: \`ss -tulpnH\` (with sudo only if it is allowed without a password; otherwise without the process names, and say so). Windows: \`Get-NetTCPConnection -State Listen\` and \`Get-NetUDPEndpoint\`, with the owning process names.

For each host, use \`recall\` to find the list you saved last time under "listening ports <host>". Compare: a port that is new, a port that went away, a service that moved from localhost to all addresses. Then \`remember\` the current list under the same name, compactly (proto, address, port, process).

The report: a verdict line first; then the changes per host; then anything listening on all addresses that usually should not be (databases, caches, admin panels, Docker's API). On the first run there is nothing to compare with: say that and give the list. Do not change anything.`,
    },

    /* ---------------- Web ---------------- */
    {
        id: 'website-down',
        name: 'Website down alert',
        category: 'web',
        description: 'Every five minutes, a free check from this computer. The agent is only woken, and you only hear, when the site stops answering.',
        needs: 'curl on this computer',
        schedule: { kind: 'heartbeat', every: '5m', probe: `curl -fsS --max-time 20 -o ${NULL_DEVICE} "{{url}}"` },
        approvals: 'read-only',
        budget: { maxToolCalls: 15, maxMinutes: 5 },
        fields: [
            { key: 'url', label: 'Address', type: 'url', required: true, placeholder: 'https://example.com/health', help: 'Checked with curl. Anything but a 2xx or 3xx answer wakes the agent.' },
        ],
        prompt: `The check on {{url}} just failed. Find out why, from this computer, with run_local_command.

The check runs every five minutes, so an outage wakes you again and again. First \`recall\` "outage {{url}}". If it holds an outage that started less than an hour ago, only check the HTTP answer: if it is still failing the same way, reply in one line ("Still down since <time>: <error>") and stop. When you find a new outage, \`remember\` "outage {{url}}" with the time and the error; when the site answers again, \`forget\` it and say it is back up.

Work down the layers and stop at the first one that is broken: DNS (\`nslookup\` the host name), the TCP connection, TLS (an expired or mismatched certificate), the HTTP answer (\`curl -sS -o ${NULL_DEVICE} -w "%{http_code} %{time_total}s" {{url}}\`), and how long it takes. Then try once more after about thirty seconds, to tell a blip from an outage.

The report, short enough to read on a lock screen: whether it is down or was a blip, what layer is broken, the error, and the likely cause. If the host is also in your inventory, say so and suggest what to check on it, without connecting. Do not change anything.`,
    },
    {
        id: 'page-watch',
        name: 'Watch a page for changes',
        category: 'web',
        description: 'Every few hours: fetch a page and tell you only when what it says has changed.',
        needs: 'Nothing: fetched from this computer',
        schedule: { kind: 'every', every: '6h' },
        approvals: 'read-only',
        budget: { maxToolCalls: 10, maxMinutes: 5 },
        fields: [
            { key: 'url', label: 'Page', type: 'url', required: true, placeholder: 'https://status.example.com' },
            { key: 'what', label: 'What to watch for', type: 'text', placeholder: 'the status of the EU region', help: 'Optional. Empty to watch the whole page.' },
        ],
        prompt: `Fetch {{url}} from this computer (curl through run_local_command, or a fetch tool if you have one) and read it as text.

What to watch: {{what}}. If that is empty, watch the page's main content and ignore what changes on every load (dates, counters, ads, session ids).

Use \`recall\` to find what you saved last time under "page watch {{url}}". If there is nothing, save a short summary of what the page says now with \`remember\` under that name, reply "Watching {{url}}" and stop. If the substance has not changed, reply with one line saying so and stop. If it has: say what changed, before and after, in a few lines, and \`remember\` the new summary under the same name. Do not change anything.`,
    },

    /* ---------------- Files ---------------- */
    {
        id: 'backup-freshness',
        name: 'Backup freshness',
        category: 'files',
        description: 'Every morning: is the newest backup recent, and is it a sensible size compared with the ones before it.',
        needs: 'A folder the backups land in',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        approvals: 'read-only',
        budget: { maxToolCalls: 20, maxMinutes: 10 },
        fields: [
            { key: 'where', label: 'On', type: 'host', local: true, default: '@local' },
            { key: 'folder', label: 'Backup folder', type: 'text', required: true, placeholder: '/srv/backups or D:\\Backups' },
            { key: 'hours', label: 'Too old after (hours)', type: 'number', default: '26' },
            { key: 'time', label: 'Time', type: 'time', default: '09:00' },
        ],
        prompt: `Check the backups in {{folder}} on {{where}}.

${HOST_ACCESS} On this computer, use the local tools instead.

Find the newest files in {{folder}}, recursively: the ten newest with their size and modification time (\`find {{folder}} -type f -printf '%T@ %s %p\\n' | sort -n | tail -10\` on Linux, \`Get-ChildItem -Recurse -File | Sort-Object LastWriteTime | Select-Object -Last 10\` on Windows).

It is a problem when: the newest backup is older than {{hours}} hours; the newest is less than half the size of the typical one before it, or zero bytes; the folder is missing or empty; or the disk it is on is over 90% full. The report: a verdict line first (backups are fresh, or what is wrong), then the newest backup's name, age and size against the typical size. Do not delete, move or rotate anything.`,
    },
    {
        id: 'local-disk-report',
        name: 'This computer\'s disk hogs',
        category: 'files',
        description: 'Every Friday: what is using the space on this computer, and what could safely go.',
        needs: 'Nothing: runs on this computer',
        schedule: { kind: 'cron', expr: '0 16 * * 5' },
        approvals: 'read-only',
        budget: { maxToolCalls: 25, maxMinutes: 15 },
        fields: [
            { key: 'time', label: 'Time', type: 'time', default: '16:00' },
        ],
        prompt: `Report on the disk space on this computer, with run_local_command.

Each drive or volume with its size and free space first. Then, for the user's profile (home folder): the largest folders two levels down, and the usual places space goes: Downloads, the temp folders, the recycle bin or trash, browser and package caches (npm, pip, NuGet, Gradle, Docker), old installers, and files over 1 GB not touched in 90 days.

The report: a verdict line first (plenty of space, or which drive is getting full), then what could be freed, largest first, as a list of what, where, how much, and whether it is safe to delete. Give the commands to clean what is safe, but do not run them, and do not delete or move anything.`,
    },
];

const byId = new Map(TEMPLATES.map(template => [template.id, template]));

/** A template as the page and the agent see it. */
function publicTemplate(template) {
    const { schedule, ...rest } = template;
    return {
        ...rest,
        schedule: { ...schedule },
        scheduleText: jobs.describeSchedule(normalized(schedule)),
    };
}

/** A template's schedule the way jobs.js keeps one, for describing it. */
function normalized(schedule) {
    const parsed = jobs.normalizeSchedule(schedule);
    return parsed.schedule || schedule;
}

function list({ query = '', category = '' } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    return TEMPLATES
        .filter(template => !category || template.category === category)
        .filter(template => !needle || [template.name, template.description, template.category, template.id]
            .some(text => text.toLowerCase().includes(needle)))
        .map(publicTemplate);
}

function get(templateId) {
    const template = byId.get(templateId);
    return template ? publicTemplate(template) : null;
}

/** '' for every host, '@local' for this computer, otherwise a host's name. */
function hostPhrase(value) {
    const name = String(value ?? '').trim();
    if (name === '@local') return 'this computer';
    if (!name) return 'every host in your inventory';
    return `the host "${name}"`;
}

const fill = (text, values) => String(text || '').replace(/\{\{(\w+)\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
));

/**
 * A template and the person's answers to a job spec for jobs.create.
 *
 * Nothing is saved. Answers `{ error }` naming the first field that is
 * missing or wrong, and otherwise `{ spec }`, whose schedule has already
 * been through the parser, so what the page previews is what will fire.
 */
function instantiate(templateId, answers = {}, { tz = '', agentId = '', name = '' } = {}) {
    const template = byId.get(templateId);
    if (!template) return { error: `No template "${templateId}".` };
    const given = answers && typeof answers === 'object' ? answers : {};

    const values = {};
    let time = '';
    for (const field of template.fields) {
        const raw = String(given[field.key] ?? field.default ?? '').trim();
        if (field.required && !raw) return { error: `${field.label} is needed.` };
        switch (field.type) {
            case 'number':
                if (raw && !Number.isFinite(Number(raw))) return { error: `${field.label} has to be a number.` };
                values[field.key] = raw;
                break;
            case 'url':
                // Inside double quotes only these are special to sh or cmd.
                if (raw && !/^https?:\/\/[^\s"'`$%\\!]+$/i.test(raw)) {
                    return { error: `${field.label} has to be an http or https address, without spaces or quotes.` };
                }
                values[field.key] = raw;
                break;
            case 'time': {
                const found = /^(\d{1,2}):(\d{2})$/.exec(raw);
                if (raw && (!found || Number(found[1]) > 23 || Number(found[2]) > 59)) {
                    return { error: `${field.label} has to be a time like 09:00.` };
                }
                time = raw;
                values[field.key] = raw;
                break;
            }
            case 'host':
                values[field.key] = hostPhrase(raw);
                break;
            default:
                values[field.key] = raw;
        }
    }

    let schedule = { ...template.schedule };
    if (schedule.kind === 'cron') {
        const fields = schedule.expr.split(/\s+/);
        if (time) {
            const [hours, minutes] = time.split(':').map(Number);
            fields[0] = String(minutes);
            fields[1] = String(hours);
        }
        schedule = { kind: 'cron', expr: fields.join(' '), ...(tz ? { tz } : {}) };
    }
    if (schedule.kind === 'heartbeat') {
        schedule = { ...schedule, probe: { command: fill(schedule.probe, values) } };
    }
    const parsed = jobs.parseSchedule(schedule);
    if (parsed.error) return { error: parsed.error };

    const spec = {
        agentId,
        name: String(name || '').trim() || template.name,
        schedule: parsed.schedule,
        prompt: fill(template.prompt, values),
        policy: { approvals: template.approvals, budget: { ...(template.budget || {}) } },
        delivery: { notify: true },
        // A daily report missed because the laptop was shut is still worth
        // having when it opens; a five-minute check is not.
        missed: schedule.kind === 'cron' ? 'catchup' : 'skip',
        template: template.id,
    };
    return { spec, scheduleText: jobs.describeSchedule(parsed.schedule) };
}

module.exports = { list, get, instantiate, CATEGORIES, TEMPLATES };
