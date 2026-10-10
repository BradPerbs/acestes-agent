import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { site, siteUrl } from "@/lib/site";
import "./gilroy.css";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

// The app's own faces, used only by the desktop app replica so it reads
// exactly like the real window.
const appSans = Inter({
  variable: "--font-app",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  preload: false,
});

const appMono = JetBrains_Mono({
  variable: "--font-app-mono",
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
  preload: false,
});

const title = "Acestes Agent: the AI agent for security, IT and computer use";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: title, template: "%s · Acestes Agent" },
  description: site.description,
  applicationName: site.name,
  keywords: [
    "AI agent",
    "cybersecurity",
    "security automation",
    "SecOps",
    "incident response",
    "computer use",
    "desktop agent",
    "SSH client",
    "IT operations",
    "sysadmin",
    "Claude Code",
    "Codex",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: site.name,
    title,
    description: site.description,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description: site.description,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
  colorScheme: "dark light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistMono.variable} ${appSans.variable} ${appMono.variable} antialiased`}
    >
      <head>
        <link rel="preconnect" href="https://fonts.cdnfonts.com" crossOrigin="" />
        {/* Marks the page as scripted before first paint, so reveal-animated
            elements start hidden instead of flashing in and out. */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:rounded-full focus:bg-fg focus:px-4 focus:py-2 focus:text-bg"
        >
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
