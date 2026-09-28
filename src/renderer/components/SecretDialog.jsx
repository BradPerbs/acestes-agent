import { useState } from 'react';
import { SquareLock02Icon } from 'hugeicons-react';
import Dialog, { DialogButton } from './ui/Dialog';
import Field, { FIELD_CLASS } from './ui/Field';
import { useT } from '../i18n';

/**
 * Name a secret and type its value.
 *
 * A dialog rather than the key editor's sheet, because a secret is two fields
 * and no modes: there is nothing to generate, nothing to import, and no public
 * half to copy out afterwards. The value goes over the bridge once and is
 * encrypted by the OS keychain before it touches the disk; it is never read
 * back, which is why replacing one is the same form as adding one rather than
 * an editor opened on what is there.
 */

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,59}$/;

export default function SecretDialog({ existing, taken = [], onSave, onClose }) {
    const t = useT();
    // Replacing arrives with the name settled, so only the value is in play.
    const [name, setName] = useState(existing?.name || '');
    const [value, setValue] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const trimmed = name.trim();
    const named = NAME.test(trimmed);
    const replacing = Boolean(existing) || taken.includes(trimmed);
    const valid = named && value.length > 0;

    const submit = async () => {
        if (!valid || busy) return;
        setBusy(true);
        setError('');
        try {
            const result = await onSave(trimmed, value);
            if (result?.error) {
                setError(result.error);
                return;
            }
            onClose();
        } catch (failure) {
            setError(failure.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            title={existing ? t('keychain.secretReplaceTitle') : t('keychain.secretAddTitle')}
            subtitle={t('keychain.secretSubtitle')}
            onClose={busy ? undefined : onClose}
            icon={
                <span className="w-9 h-9 rounded-xl flex items-center justify-center
                    bg-gray-100 dark:bg-surface-control text-gray-500 dark:text-gray-300">
                    <SquareLock02Icon size={20} strokeWidth={2} />
                </span>
            }
            footer={
                <>
                    <DialogButton onClick={onClose} disabled={busy}>{t('common.cancel')}</DialogButton>
                    <DialogButton variant="primary" onClick={submit} disabled={!valid || busy}>
                        {replacing ? t('keychain.secretReplace') : t('keychain.secretAdd')}
                    </DialogButton>
                </>
            }
        >
            <div className="flex flex-col gap-3">
                <Field
                    label={t('keychain.secretName')}
                    // The reference is the whole point of the name, so it is
                    // shown being built rather than explained after the fact.
                    hint={named ? `{{secret:${trimmed}}}` : t('keychain.secretNameHint')}
                >
                    <input
                        type="text"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        // Renaming would orphan every record already pointing at
                        // the old name, and there is no value to carry across.
                        disabled={Boolean(existing)}
                        placeholder="openai_api_key"
                        spellCheck={false}
                        autoComplete="off"
                        data-autofocus={existing ? undefined : true}
                        className={`${FIELD_CLASS} font-mono`}
                    />
                </Field>

                <Field
                    label={t('keychain.secretValue')}
                    hint={replacing ? t('keychain.secretReplaceHint') : undefined}
                    error={error || undefined}
                >
                    <input
                        type="password"
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            submit();
                        }}
                        placeholder={t('keychain.secretValue')}
                        autoComplete="new-password"
                        data-autofocus={existing ? true : undefined}
                        className={FIELD_CLASS}
                    />
                </Field>
            </div>
        </Dialog>
    );
}
