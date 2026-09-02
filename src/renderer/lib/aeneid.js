/**
 * Lines from the Aeneid, for the empty conversation.
 *
 * The agent is named for a king in the poem, so the blank page greets you in
 * its voice rather than with a slogan. One line is picked when the page is
 * drawn and stays until the tab is next opened, so it reads as a thought
 * rather than a ticker. The Latin is given under the English, with the book
 * it comes from, for anyone who wants to find the rest.
 */
export const LINES = [
    { text: 'Endure, and keep yourselves for better days.', latin: 'Durate, et vosmet rebus servate secundis.', book: 1 },
    { text: 'Perhaps one day it will be a joy to remember even this.', latin: 'Forsan et haec olim meminisse iuvabit.', book: 1 },
    { text: 'No stranger to trouble myself, I have learned to help the troubled.', latin: 'Non ignara mali, miseris succurrere disco.', book: 1 },
    { text: 'They can, because they think they can.', latin: 'Possunt, quia posse videntur.', book: 5 },
    { text: 'Wherever the fates pull us, let us follow.', latin: 'Quo fata trahunt retrahuntque, sequamur.', book: 5 },
    { text: 'Do not yield to misfortune; go more boldly to meet it.', latin: 'Tu ne cede malis, sed contra audentior ito.', book: 6 },
    { text: 'I have foreseen it all, and gone over it in my mind before.', latin: 'Omnia praecepi atque animo mecum ante peregi.', book: 6 },
    { text: 'A greater order of things opens before me; a greater work I begin.', latin: 'Maior rerum mihi nascitur ordo, maius opus moveo.', book: 7 },
    { text: 'Fortune favours the bold.', latin: 'Audentes fortuna iuvat.', book: 10 },
    { text: 'Learn courage from me, and real work; luck, from others.', latin: 'Disce, puer, virtutem ex me verumque laborem, fortunam ex aliis.', book: 12 },
];

export const pickLine = () => LINES[Math.floor(Math.random() * LINES.length)];
