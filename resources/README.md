# CloudTerm Resources

Application resources bundled into the packaged app (icons and similar assets).

Everything in this folder is copied verbatim into the installer via
`extraResources`, so do not leave build artifacts here.

The exceptions are the helpers, each compiled from source and gitignored, so
they are absent from a fresh checkout until you build them:

- `hello-helper.exe`, which `npm run build:hello` compiles and only the
  Windows package carries.
- `desktop-helper.exe`, the agent's hands for computer use on Windows, which
  `npm run build:desktop` compiles from `tools/DesktopHelper.cs`. Only the
  Windows package carries it.
- `desktop-helper`, the same on macOS, which `npm run build:desktop` compiles
  from `tools/mac/*.swift` when run on a Mac. It needs the Xcode command line
  tools (`xcode-select --install`), comes out as one binary for both Apple
  silicon and Intel, and only the macOS package carries it. `npm run build:mac`
  builds it first.

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
Windows gets `build/icon.ico` instead, built from the PNG at 16 to 256px:
handed the 1024px PNG the window accepts it but the taskbar keeps drawing
Electron's logo, since the shell wants the sizes it paints and refuses an
oversized bitmap. Regenerate the ico whenever the PNG changes.
