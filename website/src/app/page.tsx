import { Gap, Strips } from "@/components/frame";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Advanced } from "@/components/sections/advanced";
import { Changelog } from "@/components/sections/changelog";
import { Compare } from "@/components/sections/compare";
import { ComputerUse } from "@/components/sections/computer-use";
import { Cta } from "@/components/sections/cta";
import { Desktop } from "@/components/sections/desktop";
import { Faq } from "@/components/sections/faq";
import { Hero } from "@/components/sections/hero";
import { Memory } from "@/components/sections/memory";
import { Pricing } from "@/components/sections/pricing";
import { Principles } from "@/components/sections/principles";
import { Quote } from "@/components/sections/quote";
import { Runtimes } from "@/components/sections/runtimes";
import { Security } from "@/components/sections/security";
import { Team } from "@/components/sections/team";
import { Toolkit } from "@/components/sections/toolkit";
import { site, siteUrl } from "@/lib/site";

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: site.name,
  description: site.description,
  applicationCategory: "SecurityApplication",
  operatingSystem: "Windows, macOS, Linux",
  softwareVersion: site.version,
  url: siteUrl,
  downloadUrl: site.latest,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <SiteHeader />
      <div className="relative overflow-x-clip">
        <Strips />
        <main id="main">
          <Hero />
          <Gap />
          <Security />
          <Gap />
          <ComputerUse />
          <Gap />
          <Advanced />
          <Gap />
          <Principles />
          <Gap />
          <Desktop />
          <Gap />
          <Team />
          <Gap />
          <Toolkit />
          <Gap />
          <Memory />
          <Gap />
          <Compare />
          <Gap />
          <Runtimes />
          <Gap />
          <Quote />
          <Gap />
          <Pricing />
          <Gap />
          <Faq />
          <Gap />
          <Changelog />
          <Gap />
          <Cta />
          <Gap />
        </main>
        <SiteFooter />
      </div>
    </>
  );
}
