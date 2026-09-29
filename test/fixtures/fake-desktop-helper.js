/**
 * A stand-in for desktop-helper.exe, speaking its protocol over stdin and
 * stdout, for test/computer.test.js. Every request is appended to the log
 * file named first on the command line, so a test can see what reached it.
 *
 * Two apps are open: Notepad in front and a Command Prompt behind it.
 * Element 99 is where the user "takes over": clicking it answers as the real
 * helper does when a hand touches the mouse mid-action. Pressing "f12" has the
 * user press Esc instead.
 */
const fs = require('fs');
const readline = require('readline');

const log = process.argv[2];
const WINDOWS = [
    { hwnd: 101, title: 'notes.txt - Notepad', process: 'Notepad.exe', pid: 11, x: 0, y: 0, width: 800, height: 600, minimized: false, foreground: true, protected: false, elevated: false },
    { hwnd: 202, title: 'Command Prompt', process: 'cmd.exe', pid: 22, x: 100, y: 100, width: 600, height: 400, minimized: false, foreground: false, protected: false, elevated: false },
];
const NODES = [
    { id: 1, d: 0, r: 'window', n: 'notes.txt - Notepad' },
    { id: 2, d: 1, r: 'document', n: 'Text editor', v: 'hello', len: 9000, s: 'focused' },
    { id: 3, d: 1, r: 'button', n: 'Save' },
    { d: 1, offscreen: 12 },
    { d: 1, more: 4 },
];
// A long document, for read_text's pages.
const LONG = 'x'.repeat(70000);

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

send({ event: 'ready', version: 'fake', elevated: false });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    fs.appendFileSync(log, `${line}\n`);
    const reply = body => send({ id: request.id, ok: true, ...body });
    const refuse = (code, error) => send({ id: request.id, ok: false, code, error });

    switch (request.cmd) {
        case 'windows': return reply({ windows: WINDOWS });
        case 'foreground': return reply({ window: WINDOWS[0] });
        case 'focus': return reply({ window: WINDOWS.find(w => w.hwnd === request.hwnd) || WINDOWS[0] });
        case 'drive': return reply({});
        case 'tree': {
            const window = WINDOWS.find(w => w.hwnd === request.hwnd) || WINDOWS[0];
            // A search numbers nothing: "Save" is there, anything else is not.
            if (request.find) return reply({ window, ...(/save/i.test(request.find) ? { found: { r: 'button', n: 'Save' } } : {}) });
            return reply({ window, nodes: NODES, truncated: false });
        }
        case 'text': return reply({ text: LONG, length: LONG.length });
        case 'target': {
            if (request.element === 42) return refuse('protected', 'That is on the Acestes window itself, which the agent may not touch.');
            const window = request.element === 7 ? WINDOWS[1] : WINDOWS[0];
            return reply({ x: 50, y: 60, rect: [40, 50, 20, 20], window });
        }
        case 'click': {
            if (request.x === 50 && request.y === 60 && request.count === 3) {
                send({ event: 'took-over', by: 'mouse' });
                return refuse('took-over', 'The user took control of the mouse or keyboard.');
            }
            return reply({ under: 'button "Save"', window: WINDOWS[0] });
        }
        case 'type': return reply({ typed: request.text.length, window: WINDOWS[0] });
        case 'keys': {
            if (request.keys === 'f12') send({ event: 'escape' });
            return reply({ window: WINDOWS[0] });
        }
        case 'scroll': return reply({ under: 'document "Text editor"', window: WINDOWS[0] });
        case 'launch': return reply({ window: { ...WINDOWS[0], hwnd: 303, title: 'Untitled - Paint', process: 'mspaint.exe' } });
        default: return refuse('unknown', `Unknown command: ${request.cmd}`);
    }
});
