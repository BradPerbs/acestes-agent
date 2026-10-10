// Copies the app's helmet renderer and meshes into the site, so the helmets
// on the page are the ones the app draws. The app is the source of truth;
// the copy is git-ignored and refreshed before every dev and build run.
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Types for the renderer's public surface; TypeScript reads these over the JS.
const TYPES = `export type HelmetId =
  | "corinthian" | "trojan" | "attic" | "galea" | "viking"
  | "greathelm" | "barbute" | "morion" | "kabuto";
export type CrestId = "plume" | "transverse" | "horns" | "crown" | "feathers" | "none";
export const REST: { yaw: number; pitch: number };
export function whenHelmetReady(helmet?: HelmetId): Promise<boolean>;
export function framing(helmet: HelmetId, crest: CrestId, range: [number, number][]): { grow: number; dx: number; dy: number };
export function drawHelmet(
  out: HTMLCanvasElement,
  options: {
    helmet?: HelmetId; crest?: CrestId; yaw?: number; pitch?: number;
    range?: [number, number][] | null; line?: string; paper?: string | null;
    size?: number; canvasSize?: number;
  },
): boolean;
`;

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "..", "src", "renderer", "components", "assistant", "helmet");
const to = join(here, "..", "src", "lib", "helmet");

if (!existsSync(join(from, "renderer.js"))) {
  if (existsSync(join(to, "renderer.js"))) {
    console.log("sync-helmets: app sources not found, keeping the existing copy");
    process.exit(0);
  }
  console.error(`sync-helmets: no helmet renderer at ${from}`);
  process.exit(1);
}

mkdirSync(join(to, "meshes"), { recursive: true });
cpSync(join(from, "renderer.js"), join(to, "renderer.js"));
const meshes = readdirSync(join(from, "meshes")).filter((f) => f.endsWith(".js"));
for (const f of meshes) cpSync(join(from, "meshes", f), join(to, "meshes", f));
writeFileSync(join(to, "renderer.d.ts"), TYPES);
console.log(`sync-helmets: renderer + ${meshes.length} meshes`);
