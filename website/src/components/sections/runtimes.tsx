import { PiIcon } from "@hugeicons/core-free-icons";
import type { BrandName } from "@/lib/brand-paths";
import { Section } from "../frame";
import { BrandIcon, Icon } from "../icon";
import { Marquee } from "../marquee";
import { SectionHeader } from "../section-header";

type Runtime = { name: string; by: string; brand?: BrandName };

export const runtimes: Runtime[] = [
  { name: "Claude Code", by: "Anthropic", brand: "claude" },
  { name: "Codex", by: "OpenAI", brand: "openai" },
  { name: "Cursor", by: "Cursor", brand: "cursor" },
  { name: "Antigravity", by: "Google", brand: "gemini" },
  { name: "Muse Code", by: "Meta", brand: "meta" },
  { name: "Grok", by: "xAI", brand: "grok" },
  { name: "Kimi", by: "Moonshot", brand: "kimi" },
  { name: "Mistral Vibe", by: "Mistral", brand: "mistral" },
  { name: "Qwen Code", by: "Alibaba", brand: "qwen" },
  { name: "OpenCode", by: "Open source", brand: "opencode" },
  { name: "Pi", by: "Any provider" },
  { name: "Local models", by: "LM Studio, Ollama, vLLM", brand: "ollama" },
  { name: "OpenRouter", by: "Any OpenAI-style API", brand: "openrouter" },
];

function Chip({ r }: { r: Runtime }) {
  return (
    <div
      title={`${r.name} · ${r.by}`}
      className="flex items-center gap-2.5 px-6 text-muted transition-colors duration-300 hover:text-fg sm:px-8"
    >
      {r.brand ? <BrandIcon name={r.brand} size={19} /> : <Icon icon={PiIcon} size={19} strokeWidth={1.8} />}
      <span className="text-[17px] font-medium tracking-[-0.01em] whitespace-nowrap sm:text-[18px]">{r.name}</span>
    </div>
  );
}

export function Runtimes() {
  const first = runtimes.slice(0, 7);
  const second = runtimes.slice(7);
  return (
    <Section id="runtimes" label="Runtimes">
      <SectionHeader
        eyebrow="bring your own agent"
        title="Runs on the agent you already have."
        sub="Claude Code, Codex, Cursor and ten more, signed in on your own accounts. No new subscription, no key to paste."
        className="pb-10 sm:pb-12"
      />
      <ul className="sr-only">
        {runtimes.map((r) => (
          <li key={r.name}>
            {r.name}, {r.by}
          </li>
        ))}
      </ul>
      <div aria-hidden="true" className="flex flex-col gap-7 border-t border-line py-10">
        <Marquee speed={100}>
          {first.map((r) => (
            <Chip key={r.name} r={r} />
          ))}
        </Marquee>
        <Marquee speed={88} reverse>
          {second.map((r) => (
            <Chip key={r.name} r={r} />
          ))}
        </Marquee>
      </div>
    </Section>
  );
}
