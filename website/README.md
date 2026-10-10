# Acestes Agent website

The landing page for Acestes Agent. Next.js 16 (App Router, Turbopack), Tailwind CSS 4, GSAP 3.15 and Hugeicons.
It is its own npm project and is not part of the Electron build.

```
npm install
npm run dev          # http://localhost:3000
npm run build        # static export of every route
npm run typecheck && npm run lint && npm run format:check
```

## Before a release

- `src/lib/site.ts` holds the version, release date, repo links and the build file names. Bump `version` and
  `released` with each app release. Download buttons point at `releases/latest/download/<file>`, so they keep working
  as long as the asset names in `.github/workflows/release.yml` stay the same.
- `src/components/sections/changelog.tsx` lists the latest changes by hand.

## Deploying

Every route is static. Set `NEXT_PUBLIC_SITE_URL` (for example `https://acestes.example`) so canonical URLs, the
sitemap and Open Graph tags use the real domain. On Vercel it falls back to the production URL; set the project's
root directory to `website`.

## Layout

- `src/app` holds the layout, page, the generated Open Graph image, robots and sitemap.
- `src/components/sections` has one file per page section, in page order in `src/app/page.tsx`.
- `src/components/frame.tsx` is the blueprint frame: `Section` (railed column), `Gap` (dashed band with corner squares).
- `src/components/reveal.tsx` fades in any `[data-r]` child on scroll, so most sections stay server components.
- `src/lib/gsap.ts` registers ScrollTrigger, SplitText, TextPlugin and DrawSVG once. Every animation checks
  `prefers-reduced-motion` and shows its final state instead.
- `public/brand` holds alpha masks cut from `acestes.png`, `acestesicon.png` and the splash helmet; CSS paints them
  in the current text colour, so they follow the theme.
- `src/lib/brand-paths.ts` holds runtime marks from simple-icons (CC0) plus the Grok mark from `docs/logos`.
- The team cards draw the app's own helmets live (`src/components/live-helmet.tsx`). `npm run dev` and
  `npm run build` first run `scripts/sync-helmets.mjs`, which copies the app's WebGL renderer and meshes from
  `src/renderer/components/assistant/helmet/` into `src/lib/helmet/` (git-ignored), so the site always matches the
  app. Each mesh loads only as its card nears the screen. The models' licences are in the repo's
  `THIRD-PARTY-NOTICES.md`.
