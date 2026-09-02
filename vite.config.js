import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    root: path.join(__dirname, 'src/renderer'),
    base: './',
    build: {
        outDir: path.join(__dirname, 'dist/renderer'),
        emptyOutDir: true,
        // The only browser this bundle ever runs in is the Chromium inside the
        // Electron it ships with, so there is nothing to down-level for. The
        // default target is a 2021 browser matrix and would reject top-level
        // await, which the dependencies are free to use.
        target: 'esnext',
    },
    optimizeDeps: {
        esbuildOptions: {
            // The dev server pre-bundles dependencies with its own esbuild pass
            // that does not read `build.target`, so the same allowance has to be
            // made twice or `npm run dev` fails where `npm run build` succeeds.
            target: 'esnext',
        },
    },
    server: {
        port: 5173,
    },
    resolve: {
        alias: {
            '@': path.join(__dirname, 'src/renderer'),
        },
    },
});
