import { Tick02Icon } from 'hugeicons-react';
import Tooltip from '../ui/Tooltip';
import { useT } from '../../i18n';

/**
 * Whether the agent uses one account: tick as many as you like. One ticked
 * is that account; two or more and the model menu lists each one's models,
 * so every conversation picks which it runs on. The last one ticked stays
 * ticked, since the agent has to run on something.
 */
export default function AccountCheckbox({ name, checked, last = false, disabled = false, onToggle, size = 'sm', className = '' }) {
    const t = useT();
    const box = size === 'md' ? 'w-4 h-4 rounded-[6px]' : 'w-3.5 h-3.5 rounded-[5px]';
    const fixed = checked && last;
    const hint = fixed ? t('statusBar.lastTickHint') : checked ? t('statusBar.untickHint') : t('statusBar.tickHint');
    return (
        <Tooltip label={hint} placement="top">
            <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                aria-disabled={fixed || disabled}
                aria-label={t('settings.accounts.use', { name })}
                disabled={disabled && !checked}
                onClick={() => { if (!fixed && !disabled) onToggle?.(); }}
                className={`${box} shrink-0 border flex items-center justify-center transition-colors outline-none
                    focus-visible:ring-2 focus-visible:ring-gray-900/25 dark:focus-visible:ring-white/30
                    ${checked
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : 'border-gray-300 dark:border-neutral-600 hover:border-gray-500 dark:hover:border-gray-400'}
                    ${fixed ? 'cursor-default' : ''} ${disabled && !checked ? 'opacity-40 cursor-not-allowed' : ''} ${className}`}
            >
                {checked && <Tick02Icon size={size === 'md' ? 11 : 10} strokeWidth={3} />}
            </button>
        </Tooltip>
    );
}
