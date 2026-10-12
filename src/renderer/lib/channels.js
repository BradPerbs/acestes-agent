/**
 * The chat apps a message can arrive through, by the name the main process
 * tags it with (see CHANNELS in src/main/ai/index.js). Brand names, so not
 * translated.
 */
export const CHANNEL_LABELS = {
    telegram: 'Telegram',
    discord: 'Discord',
    slack: 'Slack',
    matrix: 'Matrix',
};

export const channelLabel = name => CHANNEL_LABELS[name] || '';
