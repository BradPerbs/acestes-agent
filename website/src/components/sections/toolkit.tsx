import {
  ArrowDataTransferHorizontalIcon,
  CommandLineIcon,
  FolderTransferIcon,
  Globe02Icon,
  LayoutTwoColumnIcon,
  Route01Icon,
  UsbIcon,
  VideoReplayIcon,
} from "@hugeicons/core-free-icons";
import { site } from "@/lib/site";
import { Section } from "../frame";
import { Icon } from "../icon";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";

const tools = [
  { icon: LayoutTwoColumnIcon, title: "Tabs and split panes", body: "Chats and terminals side by side." },
  { icon: FolderTransferIcon, title: "SFTP", body: "Drag and drop, both ways." },
  { icon: ArrowDataTransferHorizontalIcon, title: "Port forwarding", body: "Local, remote and dynamic." },
  { icon: VideoReplayIcon, title: "Session recording", body: "Replay what happened, keystroke by keystroke." },
  { icon: Route01Icon, title: "Jump hosts", body: "Through a bastion, as many hops as it takes." },
  { icon: Globe02Icon, title: "Proxies", body: "SOCKS and HTTP, saved per host." },
  { icon: UsbIcon, title: "Serial and Telnet", body: "For the switch in the rack." },
  { icon: CommandLineIcon, title: "Snippets and specs", body: "Your runbooks, which it follows." },
];

export function Toolkit() {
  return (
    <Section label="SSH client">
      <SectionHeader
        eyebrow="a real terminal in the bag."
        title="A serious SSH client, built in."
        className="border-b border-line"
        sub={
          <>
            Acestes grew out of{" "}
            <a
              href={site.cloudterm}
              target="_blank"
              rel="noopener noreferrer"
              className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg"
            >
              CloudTerm
            </a>
            . When the job is on a server, the agent works through the same sessions you do, in the same window.
          </>
        }
      />
      <Reveal
        draw
        className="grid grid-cols-2 gap-px bg-line lg:grid-cols-4"
        stagger={{ each: 0.05, grid: "auto", from: "start" }}
      >
        {tools.map((t) => (
          <div key={t.title} className="group/t bg-bg">
            <div data-r className="flex h-full min-h-[170px] flex-col justify-between gap-6 px-5 py-7 sm:px-8">
              <span data-draw className="text-muted transition-colors duration-300 group-hover/t:text-accent">
                <Icon icon={t.icon} size={24} strokeWidth={1.4} />
              </span>
              <div>
                <h3 className="text-[16px] font-medium tracking-[-0.01em]">{t.title}</h3>
                <p className="mt-1 text-[14px] leading-snug text-muted">{t.body}</p>
              </div>
            </div>
          </div>
        ))}
      </Reveal>
    </Section>
  );
}
