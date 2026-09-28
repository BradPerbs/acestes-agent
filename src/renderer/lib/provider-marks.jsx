import { ChatGptIcon, CpuIcon, GlobalIcon } from 'hugeicons-react';
import openCodeLogoDark from '../assets/icons/opencode-logo-dark-square.png';
import openCodeLogoLight from '../assets/icons/opencode-logo-light-square.png';

/**
 * The mark each agent goes by.
 *
 * These lived inside the settings picker while a card on that page was the only
 * place an agent was ever named. More than one agent can be switched on now, so
 * the composer's model menu lists several agents' models together and every row
 * has to say whose it is: a mark does that in the width of a checkbox, where the
 * name would take the room the model's own name needs.
 *
 * Each is drawn in `currentColor` so it takes the tint of whatever it sits in,
 * except OpenCode's, which is artwork rather than a glyph and comes as a light
 * and a dark copy.
 */

/**
 * Claude Code's mark, as the single path Simple Icons publishes for it. The
 * path data is CC0; the mark itself is Anthropic's, used here to name their
 * product and nothing else.
 */
function ClaudeCodeMark({ size = 22 }) {
    return (
        <svg
            role="img"
            aria-hidden="true"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path d="M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z" />
        </svg>
    );
}

function OpenCodeMark({ size = 22 }) {
    return (
        <>
            <img
                src={openCodeLogoLight}
                alt=""
                aria-hidden="true"
                width={size}
                height={size}
                className="block dark:hidden"
            />
            <img
                src={openCodeLogoDark}
                alt=""
                aria-hidden="true"
                width={size}
                height={size}
                className="hidden dark:block"
            />
        </>
    );
}

/**
 * Grok's mark, as the two filled strokes xAI draws it with. The mark is
 * theirs, used here to name their product and nothing else.
 *
 * What stood here before was a glyph of our own: a slash with a broken
 * diagonal across it, which is xAI's corporate mark rather than Grok's, so the
 * card carried the wrong logo for the thing it names. A card that is read by
 * its mark before its name has to carry the right one.
 */
function GrokMark({ size = 22 }) {
    return (
        <svg
            role="img"
            aria-hidden="true"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            fillRule="evenodd"
        >
            <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
        </svg>
    );
}

/**
 * Kimi's mark, as the dot and the stroke Moonshot draw it with. The mark is
 * theirs, used here to name their product and nothing else.
 */
function KimiMark({ size = 22 }) {
    return (
        <svg
            role="img"
            aria-hidden="true"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            fillRule="evenodd"
        >
            <path d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z" />
            <path d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z" />
        </svg>
    );
}

/**
 * One path in `currentColor`, the shape every mark below comes in. The path
 * data for Cursor, Mistral and Qwen is Simple Icons' (CC0); the marks
 * themselves are their owners', used here to name their products and nothing
 * else.
 */
function PathMark({ size = 22, d }) {
    return (
        <svg role="img" aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d={d} />
        </svg>
    );
}

const CURSOR_PATH = 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23';
const MISTRAL_PATH = 'M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z';
const QWEN_PATH = 'M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z';

const META_PATH = 'M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z';

/**
 * Antigravity's mark, the arch, as the single path in LobeHub's icon set
 * (MIT). The mark itself is Google's.
 */
const ANTIGRAVITY_PATH = 'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z';

/**
 * Pi's mark, taken from pi.dev's own favicon: three blocks that make the
 * letter. Its paths are drawn on a 560 grid, so it keeps that viewBox.
 */
function PiMark({ size = 22 }) {
    return (
        <svg role="img" aria-hidden="true" width={size} height={size} viewBox="0 0 560 560" fill="currentColor">
            <path d="M420 280H280V140H0V0H420V280Z" />
            <path d="M560 560H420V280H560V560Z" />
            <path d="M140 560H0V140H140V280H280V420H140V560Z" />
        </svg>
    );
}

const MARKS = {
    'claude-code': ClaudeCodeMark,
    // Meta's mark (Simple Icons, CC0 path data) for Meta's agent.
    muse: (props) => <PathMark {...props} d={META_PATH} />,
    antigravity: (props) => <PathMark {...props} d={ANTIGRAVITY_PATH} />,
    pi: PiMark,
    cursor: (props) => <PathMark {...props} d={CURSOR_PATH} />,
    vibe: (props) => <PathMark {...props} d={MISTRAL_PATH} />,
    qwen: (props) => <PathMark {...props} d={QWEN_PATH} />,
    codex: ({ size = 22 }) => <ChatGptIcon size={size} strokeWidth={1.5} />,
    opencode: OpenCodeMark,
    grok: GrokMark,
    kimi: KimiMark,
    // Not one product's mark, because it is not one product: whatever is
    // listening on the address the user typed.
    local: ({ size = 22 }) => <CpuIcon size={size} strokeWidth={1.5} />,
    // Same reason: an address and a key, which could be OpenRouter, a
    // gateway, or OpenAI itself.
    openai: ({ size = 22 }) => <GlobalIcon size={size} strokeWidth={1.5} />,
};

/** One agent's mark, or nothing at all for a name we do not draw. */
export default function ProviderMark({ provider, size = 22 }) {
    const Mark = MARKS[provider];
    return Mark ? <Mark size={size} /> : null;
}
