/**
 * Renderer-side view of what a host connects with.
 *
 * The shape and the vocabulary mirror `src/main/protocol-config.js`. They are
 * restated here rather than shared because the renderer is sandboxed and cannot
 * reach main-process modules. Main stays the authority and normalises every
 * record again before a driver or a socket ever sees it.
 */

import { translate } from '../i18n';

export const PROTOCOLS = [
    {
        id: 'ssh',
        label: 'SSH',
        summaryKey: 'protocol.ssh.summary',
        detailKey: 'protocol.ssh.detail',
    },
    {
        id: 'telnet',
        label: 'Telnet',
        summaryKey: 'protocol.telnet.summary',
        detailKey: 'protocol.telnet.detail',
    },
    {
        id: 'serial',
        labelKey: 'protocol.serial',
        summaryKey: 'protocol.serial.summary',
        detailKey: 'protocol.serial.detail',
    },
];

/**
 * What the host editor's first question offers: the three transports a shell
 * can run on. Every kind of host this app holds has a shell behind it, which
 * is what lets the agent work on any of them.
 */
export const HOST_KINDS = PROTOCOLS;

/**
 * A kind's own name, in the app's language.
 *
 * `SSH` and `Telnet` are the protocols' names and stay as they are in every
 * language; `Serial` is an ordinary word describing what the host is, and
 * carries a key.
 */
export const kindLabel = (kind) => (kind?.labelKey ? translate(kind.labelKey) : kind?.label || '');

/** Which of those a saved record is. */
export function hostKind(host) {
    return host?.protocol || 'ssh';
}

export const DEFAULT_PORTS = { ssh: 22, telnet: 23 };

export const protocolLabel = (protocol) =>
    kindLabel(PROTOCOLS.find(entry => entry.id === (protocol || 'ssh'))) || 'SSH';

/**
 * The rates worth listing. Any number is accepted on the record (an adapter
 * will run at 31250 for MIDI) but these are what a console is configured at,
 * and 115200 and 9600 are very nearly all of it.
 */
export const BAUD_RATES = [
    300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];

export const DATA_BITS = [5, 6, 7, 8];
export const STOP_BITS = [1, 1.5, 2];

export const PARITIES = [
    { id: 'none', labelKey: 'serial.parityNone' },
    { id: 'even', labelKey: 'serial.parityEven' },
    { id: 'odd', labelKey: 'serial.parityOdd' },
    { id: 'mark', labelKey: 'serial.parityMark' },
    { id: 'space', labelKey: 'serial.paritySpace' },
];

export const FLOW_CONTROLS = [
    { id: 'none', labelKey: 'serial.flowNone' },
    { id: 'rtscts', labelKey: 'serial.flowHardware' },
    { id: 'xonxoff', labelKey: 'serial.flowSoftware' },
];

// The names are the control codes themselves, the same in every language; the
// hints are the ordinary prose that says which device wants which.
export const NEWLINES = [
    { id: 'cr', label: 'CR', hintKey: 'serial.newlineCrHint' },
    { id: 'lf', label: 'LF', hintKey: 'serial.newlineLfHint' },
    { id: 'crlf', label: 'CR LF', hintKey: 'serial.newlineCrLfHint' },
];

export const DEFAULT_SERIAL = {
    path: '',
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    newline: 'cr',
    localEcho: false,
    dtr: true,
    rts: true,
};

/**
 * `115200 8N1`, the form every piece of console documentation is written in,
 * and the fastest way to check a setting against the label on a device.
 */
export function describeLine(serial = {}) {
    const config = { ...DEFAULT_SERIAL, ...serial };
    const parity = config.parity === 'none' ? 'N' : config.parity.charAt(0).toUpperCase();
    const stop = config.stopBits === 1.5 ? '1.5' : String(config.stopBits);
    return `${config.baudRate} ${config.dataBits}${parity}${stop}`;
}
