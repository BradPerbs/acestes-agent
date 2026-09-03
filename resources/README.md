# CloudTerm Resources

Application resources bundled into the packaged app (icons and similar assets).

Everything in this folder is copied verbatim into the installer via
`extraResources`, so do not leave build artifacts here.

The one exception is `hello-helper.exe`, which `npm run build:hello` compiles
and which only the Windows package carries. It is filtered out of the macOS and
Linux builds, and it is gitignored, so it is absent from a fresh checkout until
you build it.

## Icons

The app icon is not here. It lives at `build/icon.png` in the repo root, and
all three platform targets point at that one file: electron-builder generates
the Windows `.ico` and the macOS `.icns` from it, and Linux takes the PNG as
it is.

`win.icon` used to name `resources/icon.ico`, which was never committed, so
every Windows build up to now quietly shipped the default Electron logo.
electron-builder warns about a missing icon rather than failing, which is how
that went unnoticed.

**The current `build/icon.png` is built from `acestesicon.png` in the repo root**,
which is 363x363 and so below the minimum every target needs (256 for Linux and
the Windows ico, 512 for the macOS icns).

The upscale is not a plain resample. `acestesicon.png` measures as a rounded
square flush to its canvas with a corner radius of 35.8% of the side over a
flat `#0E0E10`, so the frame is redrawn analytically at 1024 from that
geometry and only the artwork is resampled. That keeps the silhouette a
one-pixel edge instead of feathering it over five, which is the part of an
icon the eye reads first. The artwork itself is a 2.8x interpolation and is
soft if you go looking at full size, though it is invisible by the time
anything downscales it to a taskbar.

Replacing this with a real 1024x1024 export is still worth doing the next time
the source art is to hand. Dropping that in at the same path is the whole job:
no configuration changes with it.

The same file is also copied into the package as `icon.png` (see
`extraResources`) and handed to every BrowserWindow by `src/main/app-icon.js`,
which is what puts it on a dev run's windows, where nothing else would.
