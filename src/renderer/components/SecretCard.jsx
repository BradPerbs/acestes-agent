import { memo, useCallback } from 'react';
import {
    Copy01Icon,
    Delete02Icon,
    Edit02Icon,
    MoreVerticalIcon,
    SquareLock02Icon,
} from 'hugeicons-react';
import IconTile from './hosts/IconTile';
import MenuButton from './ui/MenuButton';

/**
 * One secret in the keychain, as a tile in the grid.
 *
 * Built to the same two lines as a key card, because it is the same kind of
 * object in the same collection: what it is called, and the one string that
 * identifies it. For a key that is the fingerprint; for a secret it is the
 * reference, `{{secret:name}}`, which is the thing you actually paste into a
 * host's password field or an MCP server's headers. It is the only part of a
 * secret that ever leaves this process, so it is the part the card shows.
 *
 * There is no value on the card and no way to reveal one. A stored value goes
 * out to the thing that needs it, in the main process, and comes back to
 * nobody — not the agent, not a transcript, and not here.
 *
 * Nor is there the key card's count of what depends on it. A reference can be
 * sitting in a host's password, an MCP server's headers or a proxy's login, and
 * those are exactly the fields the bridge replaces with a `has…` flag on the
 * way out, so the renderer cannot count them without being handed the very
 * values this store exists to keep from it.
 */

/** The card is the replace button, so the menu on it opts out of that click. */
const stop = (event) => event.stopPropagation();

function when(at) {
    if (!at) return '';
    const date = new Date(at);
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
        + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function SecretCard({ secret, onReplace, onCopyReference, onDelete }) {

    const handleClick = useCallback((event) => {
        if (event.target.closest('[data-action]')) return;
        onReplace();
    }, [onReplace]);

    // Enter and Space reach the card through the keyboard; without them a
    // secret could be tabbed to and not opened.
    const handleKeyDown = useCallback((event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onReplace();
    }, [onReplace]);

    const menuItems = [
        { label: 'Replace value', icon: <Edit02Icon size={14} strokeWidth={2} />, onSelect: onReplace },
        { label: 'Copy reference', icon: <Copy01Icon size={14} strokeWidth={2} />, onSelect: onCopyReference },
        { separator: true },
        { label: 'Delete', icon: <Delete02Icon size={14} strokeWidth={2} />, danger: true, onSelect: onDelete },
    ];

    return (
        <div
            // What useFlipOrder follows a card by when the grid rewraps.
            data-card-id={secret.name}
            className="org-card group relative cursor-pointer rounded-2xl p-2.5"
            role="button"
            tabIndex={0}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
        >
            <div className="flex items-center gap-2.5">
                <IconTile size="md">
                    <SquareLock02Icon size={20} strokeWidth={1.5} className="text-gray-500 dark:text-gray-300" />
                </IconTile>

                <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-gray-900 dark:text-white text-sm truncate leading-tight">
                        {secret.name}
                    </h3>

                    {/* The marks keep their width and the reference gives way,
                        for the reason the key card's fingerprint does: a
                        truncated reference still says which secret this is,
                        while half a warning says nothing. */}
                    <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
                        <p className="flex-1 min-w-0 text-[11px] text-gray-500 dark:text-gray-400 truncate leading-tight">
                            <span className="font-mono" title={secret.reference}>{secret.reference}</span>
                            {secret.updatedAt && (
                                <>
                                    <span className="mx-1 opacity-50">·</span>
                                    {when(secret.updatedAt)}
                                </>
                            )}
                        </p>

                        <span className="shrink-0 flex items-center gap-1.5">
                            {/* A secret encrypted by an OS keychain this
                                machine can no longer open is a real record
                                with a real name, and nothing else on the card
                                would say that its value is gone. */}
                            {!secret.readable && (
                                <span
                                    title="This machine cannot decrypt this value. Set it again to repair it"
                                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md
                                        bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"
                                >
                                    Unreadable
                                </span>
                            )}
                        </span>
                    </div>
                </div>

                {/* Idle cards stay quiet; the controls come up on hover, and on
                    keyboard focus so they are still reachable without a mouse. */}
                <div
                    data-action="menu"
                    onClick={stop}
                    className="shrink-0 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
                >
                    <MenuButton
                        icon={<MoreVerticalIcon size={16} strokeWidth={2} />}
                        title="Secret actions"
                        items={menuItems}
                    />
                </div>
            </div>
        </div>
    );
}

export default memo(SecretCard);
