import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const display = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

// Reserved for measured values - dB, Hz, seconds, counts - never for labels.
const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

/**
 * Site-wide metadata.
 *
 * The Open Graph block is not decoration. This gets shared as a link in group
 * chats and on social sites, and a link with no preview is a bare URL nobody
 * clicks. metadataBase must be an absolute origin or Next emits relative image
 * URLs, which every scraper ignores.
 */
const SITE = "https://skyear.lt";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: "SkyEar — security cameras listening for aircraft",
    template: "%s · SkyEar",
  },
  description:
    "Security cameras already have microphones. SkyEar listens to them and checks every " +
    "detection against live aircraft positions, so the map shows what was missed as well as " +
    "what was heard.",
  applicationName: "SkyEar",
  keywords: [
    "acoustic sensor",
    "aircraft detection",
    "drone detection",
    "ADS-B",
    "Home Assistant",
    "security camera",
    "Lithuania",
  ],
  openGraph: {
    type: "website",
    siteName: "SkyEar",
    url: SITE,
    locale: "en",
    title: "Security cameras listening for aircraft",
    description:
      "Every detection is checked against live ADS-B, so the map shows the aircraft that were " +
      "missed as well as the ones that were heard. Run a sensor on a camera you already own.",
  },
  twitter: {
    card: "summary_large_image",
    title: "SkyEar — security cameras listening for aircraft",
    description:
      "Every detection checked against live ADS-B. The map shows what was missed as well as " +
      "what was heard.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
