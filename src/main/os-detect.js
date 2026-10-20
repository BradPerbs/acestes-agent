/**
 * Turning the output of `cat /etc/os-release` and `uname -a` from a live
 * session into the os/distro pair the icons are keyed on.
 *
 * Order matters: the derivatives come before the distributions they are built
 * on, or every Kubuntu is an Ubuntu and every Manjaro is an Arch.
 */

const DISTRO_MAP = [
    [['id=kubuntu', 'kubuntu'], 'kubuntu'],
    [['id=lubuntu', 'lubuntu'], 'lubuntu'],
    [['id=xubuntu', 'xubuntu'], 'xubuntu'],
    [['id=ubuntu', 'ubuntu'], 'ubuntu'],
    [['id=debian', 'debian'], 'debian'],
    [['id=fedora', 'fedora'], 'fedora'],
    [['id=centos', 'centos'], 'centos'],
    [['id=rhel', 'red hat', 'rhel'], 'rhel'],
    [['id=rocky', 'rocky'], 'rocky'],
    [['id=almalinux', 'id=alma', 'almalinux', 'alma linux'], 'alma'],
    [['id=endeavouros', 'endeavour'], 'endeavour'],
    [['id=garuda', 'garuda'], 'garuda'],
    [['id=arcolinux', 'arco'], 'arco'],
    [['id=artix', 'artix'], 'artix'],
    [['id=manjaro', 'manjaro'], 'manjaro'],
    [['id=arch', 'archlinux', 'arch linux'], 'arch'],
    [['id=alpine', 'alpine'], 'alpine'],
    [['id=nixos', 'nixos'], 'nixos'],
    [['id=gentoo', 'gentoo'], 'gentoo'],
    [['id=opensuse', 'id=sles', 'suse'], 'suse'],
    [['id=linuxmint', 'linux mint'], 'mint'],
    [['id=pop', 'pop!_os'], 'pop'],
    [['id=elementary', 'elementary'], 'elementary'],
    [['id=zorin', 'zorin'], 'zorin'],
    [['id=deepin', 'deepin'], 'deepin'],
    [['id=kali', 'kali'], 'kali'],
    [['id=parrot', 'parrot'], 'parrot'],
    [['id=tails', 'tails'], 'tails'],
    [['id=mx', 'mx linux'], 'mx'],
    [['id=void', 'void'], 'void'],
    [['id=solus', 'solus'], 'solus'],
    [['id=slackware', 'slackware'], 'slackware'],
    [['id=raspbian', 'raspberry'], 'raspios'],
    [['id=amzn', 'amazon'], 'amazon'],
];

/** The distro key for some text, or '' when nothing in the table matches. */
function matchDistro(lower) {
    for (const [keywords, name] of DISTRO_MAP) {
        if (keywords.some(keyword => lower.includes(keyword))) return name;
    }
    return '';
}

/**
 * Classify shell output from a live session.
 *
 * Linux is the default rather than 'unknown' because this only ever runs
 * against a server that answered an SSH exec, and the family checks below are
 * the ones that can be made confidently from `uname`.
 */
function classifyShellOutput(output) {
    const lower = String(output || '').toLowerCase();

    let os = 'linux';
    if (lower.includes('darwin')) os = 'macos';
    else if (lower.includes('microsoft') || lower.includes('windows')) os = 'windows';
    else if (lower.includes('freebsd')) os = 'freebsd';
    else if (lower.includes('openbsd')) os = 'openbsd';

    return { os, distro: os === 'linux' ? matchDistro(lower) : '' };
}

module.exports = {
    DISTRO_MAP,
    matchDistro,
    classifyShellOutput,
};
