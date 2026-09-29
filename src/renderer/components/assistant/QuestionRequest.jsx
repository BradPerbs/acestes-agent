import { useState } from 'react';
import { ArrowRight01Icon, Edit02Icon } from 'hugeicons-react';
import Button from '../ui/Button';
import { CARD, CARD_HEAD, CHOICE, CHOICE_ICON, FIELD } from './ApprovalRequest';
import { useT } from '../../i18n';

/**
 * A question the agent asked, stopped in front of the user.
 *
 * The approval card's sibling, and drawn to the same rules: the tool row's
 * 32px header with the amber dot that means "waiting", a neutral surface
 * lifted by a border rather than a colour wash, and the answers as a list of
 * full-width rows rather than buttons in a line. The styles are shared with it
 * so the two cannot drift apart when they stand in the same stack. What differs is the
 * content. There is no command to show verbatim and no server to name; there
 * is a sentence, and under it the answers the agent offered, then a way to
 * say something else, which is always there because the agent's list is a
 * guess at what the person will want to say.
 *
 * Pinned above the composer while it stands, for the reason an approval is,
 * and collapsed to a one-line row in the transcript once answered, with the
 * answer on it so the exchange can be read back.
 */

const SETTLED = {
    answered: { labelKey: 'assistant.answered', dot: 'bg-emerald-500' },
    dismissed: { labelKey: 'assistant.dismissed', dot: 'bg-gray-400 dark:bg-gray-600' },
    expired: { labelKey: 'assistant.timedOut', dot: 'bg-gray-400 dark:bg-gray-600' },
};

export default function QuestionRequest({ item, onAnswer }) {
    const t = useT();
    // A secret opens straight on its masked field: there are no options to
    // pick from, and the value must not be typed anywhere else.
    const [note, setNote] = useState(item.secret ? '' : null);

    const settled = SETTLED[item.status];
    if (settled) {
        return (
            <div className="h-8 px-2.5 flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-white/[0.035]">
                <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${settled.dot}`} />
                <span className="text-[11px] font-medium text-gray-600 dark:text-gray-400 shrink-0">
                    {t(settled.labelKey)}
                </span>
                <span
                    className="min-w-0 flex-1 truncate text-[11px] text-gray-500 dark:text-gray-500"
                    title={item.answer ? `${item.question}\n\n${item.answer}` : item.question}
                >
                    {item.answer || item.question}
                </span>
            </div>
        );
    }

    const sendNote = () => {
        const text = (note || '').trim();
        if (text) onAnswer(item.requestId, text, false, Boolean(item.secret));
    };

    // The agent stopped waiting, and said so; the card stays for the answer,
    // which then goes as a message rather than into the call that asked.
    // Not for a secret: a message is where one must not go, so that card
    // only says to ask again.
    const parked = item.status === 'parked';

    return (
        <div className={CARD}>
            <div className={CARD_HEAD}>
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" />
                <span className="text-[11px] font-semibold text-gray-900 dark:text-white shrink-0">
                    {t('assistant.asks')}
                </span>
            </div>

            <div className="p-2 space-y-2">
                <p className="px-0.5 text-xs leading-relaxed text-gray-900 dark:text-gray-100 whitespace-pre-wrap break-words">
                    {item.question}
                </p>
                {parked && (
                    <p className="px-0.5 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                        {item.secret ? t('assistant.secretParked') : t('assistant.questionParked')}
                    </p>
                )}

                {item.secret && !parked && (
                    <div className={FIELD}>
                        <input
                            autoFocus
                            type="password"
                            autoComplete="off"
                            value={note || ''}
                            onChange={(event) => setNote(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    sendNote();
                                }
                            }}
                            placeholder={t('assistant.secretPlaceholder', { name: item.secretName })}
                            className="block w-full px-2.5 py-2 bg-transparent outline-none
                                text-xs leading-relaxed text-gray-900 dark:text-white
                                placeholder:text-gray-400 dark:placeholder:text-gray-600"
                        />
                        <div className="flex items-center justify-between gap-2 px-2.5 pb-1.5">
                            <span className="text-[11px] text-gray-500 dark:text-gray-400">{t('assistant.secretHint')}</span>
                            <Button size="sm" variant="primary" disabled={!(note || '').trim()} onClick={sendNote}>
                                {t('assistant.send')}
                            </Button>
                        </div>
                    </div>
                )}

                {item.secret ? null : note === null ? (
                    <div className="space-y-1.5">
                        {item.options.map((option, index) => (
                            <button
                                key={`${index}-${option}`}
                                type="button"
                                onClick={() => onAnswer(item.requestId, option, true)}
                                className={CHOICE}
                            >
                                <span className={CHOICE_ICON}>
                                    <ArrowRight01Icon size={14} strokeWidth={2.5} />
                                </span>
                                <span className="min-w-0 break-words">{option}</span>
                            </button>
                        ))}
                        <button type="button" onClick={() => setNote('')} className={CHOICE}>
                            <span className={CHOICE_ICON}>
                                <Edit02Icon size={13} strokeWidth={2} />
                            </span>
                            {item.options.length > 0 ? t('assistant.somethingElse') : t('assistant.typeAnswer')}
                        </button>
                    </div>
                ) : (
                    <div className={FIELD}>
                        <textarea
                            autoFocus
                            rows={2}
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault();
                                    sendNote();
                                }
                                if (event.key === 'Escape') {
                                    event.stopPropagation();
                                    setNote(null);
                                }
                            }}
                            placeholder={t('assistant.answerPlaceholder')}
                            className="block w-full max-h-32 px-2.5 pt-2 pb-1 bg-transparent
                                resize-none outline-none
                                text-xs leading-relaxed text-gray-900 dark:text-white
                                placeholder:text-gray-400 dark:placeholder:text-gray-600"
                        />
                        <div className="flex items-center justify-end gap-1.5 px-1.5 pb-1.5">
                            <Button size="sm" variant="secondary" onClick={() => setNote(null)}>
                                {t('common.cancel')}
                            </Button>
                            <Button
                                size="sm"
                                variant="primary"
                                disabled={!note.trim()}
                                onClick={sendNote}
                            >
                                {t('assistant.send')}
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
