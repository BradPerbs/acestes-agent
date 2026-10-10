import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Acestes Agent: every agent, every account, one app.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const blocks: [number, number, number][] = [
  // col, row, span on a 6 x 7 grid
  [5, 0, 1],
  [3, 1, 1],
  [4, 1, 2],
  [4, 2, 1],
  [5, 2, 1],
  [4, 3, 2],
  [3, 4, 1],
  [4, 4, 2],
  [2, 5, 1],
  [3, 5, 3],
  [4, 6, 2],
];

export default async function Image() {
  const wordmark = await readFile(join(process.cwd(), "public/brand/wordmark.png"));
  const src = `data:image/png;base64,${wordmark.toString("base64")}`;

  const cell = 90;
  const gridLeft = 1200 - 6 * cell;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: "radial-gradient(90% 80% at 30% 120%, #3b1478 0%, #12071f 55%, #000 100%)",
        color: "#f7f5fc",
        position: "relative",
      }}
    >
      {/* grid lines */}
      {Array.from({ length: 7 }, (_, i) => (
        <div
          key={`v${i}`}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: gridLeft + i * cell,
            width: 1,
            background: "#221a30",
          }}
        />
      ))}
      {Array.from({ length: 8 }, (_, i) => (
        <div
          key={`h${i}`}
          style={{ position: "absolute", left: gridLeft, right: 0, top: i * cell, height: 1, background: "#221a30" }}
        />
      ))}
      {blocks.map(([c, r, s], i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: gridLeft + c * cell + 10,
            top: r * cell + 10,
            width: s * cell - 20,
            height: cell - 20,
            background:
              i % 3 === 1 ? "linear-gradient(270deg, #2a1259, #7c3aed)" : "linear-gradient(90deg, #2a1259, #7c3aed)",
          }}
        />
      ))}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          width: 660,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} width={210} height={54} alt="" />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 54,
            fontWeight: 600,
            letterSpacing: -2.5,
            lineHeight: 1.04,
          }}
        >
          <span>Every agent.</span>
          <span>Every account.</span>
          <span style={{ color: "#c4a5ff" }}>One app.</span>
        </div>
        <div style={{ display: "flex", fontSize: 24, color: "#a1a1aa" }}>
          Claude Code, Codex, Cursor and ten more. Free on Windows, macOS and Linux.
        </div>
      </div>
    </div>,
    size,
  );
}

export const dynamic = "force-static";
