# Third-party notices

Acestes includes work by others under their own licences. This file lists the
ones whose licences ask for credit wherever the work is used. Packages installed
from npm carry their own licence files in `node_modules`.

## Spartan Helm

The agent mark is drawn from "Spartan Helm" by HeadlessMoose,
<https://www.thingiverse.com/thing:1643968>, licensed under the Creative Commons
Attribution 3.0 Unported licence, <https://creativecommons.org/licenses/by/3.0/>.

Changed for Acestes: re-oriented and scaled; the crest separated from the helmet
so it can be taken off, and the helmet closed where the crest stood; strands
drawn on the crest; packed into `src/renderer/components/assistant/helmet/meshes/corinthian.js`
and drawn as line art. `scripts/helmets` makes these changes from the original.

## The other helmets

An agent can wear one of these instead. Each is licensed by its author under the
Creative Commons Attribution 4.0 International licence,
<https://creativecommons.org/licenses/by/4.0/>, and read from the copy of it
kept on Zenodo by the Objaverse archive.

- "Trojan Helmet" by JeremyGrayson, <https://sketchfab.com/3d-models/trojan-helmet-78922e88c92a478f81e6b2434dd4b421>
- "Attic Helmet" by Ascalon1, <https://sketchfab.com/3d-models/attic-helmet-f2c28c80da50412fa97e02069f279790>
- "Roman Legionnaire Helmet" by AlbertoGalindo3D, <https://sketchfab.com/3d-models/roman-legionnaire-helmet-608c6fdd20174b7b8c77ac585042664c>
- "Norwegian Viking Helmet [Gjermundbu type)" by JohnyNawalony, <https://sketchfab.com/3d-models/norwegian-viking-helmet-gjermundbu-type-b0b7e489f934497599cd08957c7a48ea>
- "Crusader Helmet" by rookieray, <https://sketchfab.com/3d-models/crusader-helmet-62f2b06e7adc4cd29ba9dccbede57ddb>
- "Visored Barbute Helmet" by dentro, <https://sketchfab.com/3d-models/visored-barbute-helmet-5e3d0edb528e429e8f2e7b705423b0a9>
- "Spanish Morion Helmet" by altay16, <https://sketchfab.com/3d-models/spanish-morion-helmet-d16ade982443485b8e39235e12316770>
- "Kabuto" by sneeky, <https://sketchfab.com/3d-models/kabuto-96138c309eda41e1a7e3ecf508190235>

Changed for Acestes: re-oriented, scaled and simplified; the Trojan's crest kept
apart so it can be taken off; packed into
`src/renderer/components/assistant/helmet/meshes/` and drawn as line art.
`scripts/helmets` makes these changes from the originals.

## The crests

A helmet can wear the Corinthian's crest (from "Spartan Helm" above), front to
back or turned across, or one of these:

- Horns: "Viking Helmet Horns - Cracked Horn" by pittance,
  <https://www.thingiverse.com/thing:1374884>, licensed under the Creative
  Commons Attribution 3.0 Unported licence, <https://creativecommons.org/licenses/by/3.0/>.
- Crown: "Royal Crown" by gizacorp01,
  <https://sketchfab.com/3d-models/royal-crown-36edb23a404349709c9da94f136351e9>,
  licensed under the Creative Commons Attribution 4.0 International licence,
  <https://creativecommons.org/licenses/by/4.0/>, read from the Objaverse copy on Zenodo.
- Feathers: "Golden Plume/ Feather" by syngineer,
  <https://www.thingiverse.com/thing:4209542>, licensed under the Creative
  Commons Attribution 4.0 International licence, <https://creativecommons.org/licenses/by/4.0/>.

Changed for Acestes: simplified, and bent, stretched or placed to fit each
helmet (the crown round its bowl, the horns at its temples, three feathers
fanned at its back); packed with the helmet in
`src/renderer/components/assistant/helmet/meshes/`. `scripts/helmets/crests.mjs`
makes these changes from the originals.

## Speech models

Voice input's Parakeet engine downloads these on its first use; they are not
part of the app's own files.

- "Parakeet TDT 0.6B v3" by NVIDIA, <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>,
  licensed under the Creative Commons Attribution 4.0 International licence,
  <https://creativecommons.org/licenses/by/4.0/>. Used in the int8 ONNX export
  made by the sherpa-onnx project,
  <https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8>;
  not changed further.
- "Silero VAD" by Silero Team, <https://github.com/snakers4/silero-vad>, licensed
  under the MIT licence, in the copy published by sherpa-onnx.
