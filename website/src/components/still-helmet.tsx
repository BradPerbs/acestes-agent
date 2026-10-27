"use client";

import { useEffect, useRef, useState } from "react";
import { REST, drawHelmet, whenHelmetReady, type CrestId, type HelmetId } from "@/lib/helmet/renderer";
import { Helmet } from "./brand";

/**
 * An agent's mark at rest, the way the app draws its small ones (AgentMark's
 * StillMark): one drawing, three quarters on, in the agent's ink, for tabs,
 * list rows and the picker. Any helmet and crest; while the model loads, or
 * without WebGL2, the Corinthian outline in the same colour holds the place.
 */
export function StillHelmet({
  helmet = "corinthian",
  crest = "plume",
  size = 16,
  color,
  className = "",
}: {
  helmet?: HelmetId;
  crest?: CrestId;
  size?: number;
  /** The ink, as agentInk() gives it for a dark theme. */
  color: string;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    let current = true;
    whenHelmetReady(helmet).then((ok) => {
      const node = canvas.current;
      if (!current || !ok || !node) return;
      const ratio = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
      node.width = Math.round(size * ratio);
      node.height = Math.round(size * ratio);
      const done = drawHelmet(node, {
        helmet,
        crest,
        size,
        canvasSize: size,
        yaw: REST.yaw,
        pitch: REST.pitch,
        range: null,
        line: color,
        paper: null,
      });
      setDrawn(done);
    });
    return () => {
      current = false;
    };
  }, [helmet, crest, size, color]);

  return (
    <span
      aria-hidden="true"
      className={`relative inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {!drawn && <Helmet size={size} color={color} className="absolute inset-0" />}
      <canvas
        ref={canvas}
        className="absolute inset-0 max-w-none"
        style={{ width: size, height: size, visibility: drawn ? "visible" : "hidden" }}
      />
    </span>
  );
}
