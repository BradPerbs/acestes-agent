/**
 * The helmets an agent can wear besides the Corinthian (which is `source.mjs`,
 * and made its own way), and where each one comes from.
 *
 * Every one is a model someone published under CC BY 4.0 on Sketchfab, read
 * from the copy Zenodo keeps of it (the Objaverse archive, community
 * "3dbigdataspace"), which can be downloaded without an account. Each is
 * cached next to this file, so it is downloaded once.
 *
 * - `record`, `file`: the Zenodo record and the file in it.
 * - `url`: the model on Sketchfab, for the credit.
 * - `turn`: degrees about the vertical that turn the face to look along +Z,
 *   where the model does not already (glTF is Y up, like the app's frame).
 * - `crest`: which meshes in the file are a crest the helmet can take off,
 *   by their order in the scene. Taken off, nothing needs closing: they are
 *   separate pieces standing on a whole helmet.
 * - `faces`: how many faces to keep; the heavy ones are simplified to it.
 * - `bare`: wears none of the other crests (`crests.mjs`): its own
 *   ornaments stand where they would.
 *
 * The order is the order they are offered in (`src/renderer/lib/agent-look.js`
 * keeps the same list, and `src/main/agents.js` the ids).
 */
export const HELMETS = [
    {
        id: 'trojan',
        title: 'Trojan Helmet',
        author: 'JeremyGrayson',
        url: 'https://sketchfab.com/3d-models/trojan-helmet-78922e88c92a478f81e6b2434dd4b421',
        record: 10263775,
        file: '78922e88c92a478f81e6b2434dd4b421.glb',
        crest: [1],
    },
    {
        id: 'attic',
        title: 'Attic Helmet',
        author: 'Ascalon1',
        url: 'https://sketchfab.com/3d-models/attic-helmet-f2c28c80da50412fa97e02069f279790',
        record: 10348867,
        file: 'f2c28c80da50412fa97e02069f279790.glb',
    },
    {
        id: 'galea',
        title: 'Roman Legionnaire Helmet',
        author: 'AlbertoGalindo3D',
        url: 'https://sketchfab.com/3d-models/roman-legionnaire-helmet-608c6fdd20174b7b8c77ac585042664c',
        record: 10237277,
        file: '608c6fdd20174b7b8c77ac585042664c.glb',
    },
    {
        id: 'viking',
        title: 'Norwegian Viking Helmet [Gjermundbu type)',
        author: 'JohnyNawalony',
        url: 'https://sketchfab.com/3d-models/norwegian-viking-helmet-gjermundbu-type-b0b7e489f934497599cd08957c7a48ea',
        record: 10329652,
        file: 'b0b7e489f934497599cd08957c7a48ea.glb',
        turn: -90,
    },
    {
        id: 'greathelm',
        title: 'Crusader Helmet',
        author: 'rookieray',
        url: 'https://sketchfab.com/3d-models/crusader-helmet-62f2b06e7adc4cd29ba9dccbede57ddb',
        record: 10343016,
        file: '62f2b06e7adc4cd29ba9dccbede57ddb.glb',
    },
    {
        id: 'barbute',
        title: 'Visored Barbute Helmet',
        author: 'dentro',
        url: 'https://sketchfab.com/3d-models/visored-barbute-helmet-5e3d0edb528e429e8f2e7b705423b0a9',
        record: 10241751,
        file: '5e3d0edb528e429e8f2e7b705423b0a9.glb',
    },
    {
        id: 'morion',
        title: 'Spanish Morion Helmet',
        author: 'altay16',
        url: 'https://sketchfab.com/3d-models/spanish-morion-helmet-d16ade982443485b8e39235e12316770',
        record: 10221204,
        file: 'd16ade982443485b8e39235e12316770.glb',
    },
    {
        id: 'kabuto',
        title: 'Kabuto',
        author: 'sneeky',
        url: 'https://sketchfab.com/3d-models/kabuto-96138c309eda41e1a7e3ecf508190235',
        record: 10317597,
        file: '96138c309eda41e1a7e3ecf508190235.glb',
        bare: true,
    },
];

export const LICENCE = { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' };
