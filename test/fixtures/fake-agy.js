/**
 * A scripted `agy`, for the Antigravity provider's tests. Speaks the
 * documented print-mode stream-json shapes: `init`, `step_update`, `result`.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ''; };
const repeated = (name) => args.flatMap((arg, index) => (arg === name ? [args[index + 1] || ''] : []));
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (args[0] === 'models') {
    // The real subcommand takes no `--output-format` flag and prints TSV.
    if (args.includes('--output-format')) {
        process.stderr.write('Error: flags provided but not defined: -output-format\n');
        process.exit(1);
    }
    process.stdout.write('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n');
    process.stdout.write('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n');
    process.stdout.write('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n');
    process.stdout.write('claude-opus-4.6\tClaude Opus 4.6 (thinking)\n');
    process.exit(0);
}
if (args[0] === '-p' && args[1] === '/usage') {
    out({ status: 'SUCCESS', response: JSON.stringify({ email: 'me@example.com', plan_tier: 'pro', quota: { 'gemini-5h': { remaining_fraction: 0.75, reset_in_seconds: 3600 }, 'gemini-weekly': { remaining_fraction: 0.4, reset_time: '2026-10-01T00:00:00Z' } } }) });
    process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    const message = JSON.parse(input.trim().split('\n')[0]);
    const text = message.message.content;
    const conversation = flag('--conversation') || 'conv-1';
    let config = {};
    try { config = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8')); } catch { /* none */ }
    const servers = Object.keys(config.mcpServers || {});

    out({ event: 'init', conversation_id: conversation, init: { cwd: process.cwd(), tools: servers.includes('remote') ? ['run_command', 'mcp_remote_list_hosts'] : ['run_command'], permission_mode: 'request-review' } });
    out({ event: 'step_update', step_update: { step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Looking. ' } });
    out({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'mcp_remote_list_hosts', parameters: {} } } });
    out({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_info: { name: 'mcp_remote_list_hosts', parameters: {}, output: 'two hosts' } } });
    const reply = `Found them. conversation=${conversation} model=${flag('--model')} effort=${flag('--effort')} skip=${args.includes('--dangerously-skip-permissions')} servers=${servers.join(',')} prompt=${text.startsWith('SYSTEM') ? 'with-system' : 'plain'} cwd=${process.cwd()} dirs=${repeated('--add-dir').join('|')}`;
    out({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: reply } });
    out({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response' } });
    out({ event: 'result', result: {
        conversation_id: conversation,
        status: text.includes('fail') ? 'ERROR' : 'SUCCESS',
        error: text.includes('fail') ? { message: 'model unavailable' } : undefined,
        response: reply,
        usage: { input_tokens: 500, output_tokens: 50, thinking_tokens: 25, cache_read_tokens: 100, total_tokens: 575 },
        denied_actions: text.includes('write') ? [{ tool: 'write_file', target: 'notes.txt' }] : [],
    } });
    process.exit(0);
});
