import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // v1.14.2: the title states what the product is — a Windows desktop app
  // (the browser route is a landing page / dev preview, not the product).
  title: "FrameFuse v1.26.0 — Windows Desktop Video Studio",
  description:
    "Multi-track Windows desktop video studio: video clips, green-screen chroma key with on-canvas PiP, background music with volume & loop, SFX, native Whisper captions, and fast native export.",
  applicationName: "FrameFuse",
  // v7 FIX B: browser-tab icons come from the App Router file conventions —
  // src/app/icon.ico (multi-size DIB/PNG build) + src/app/apple-icon.png.
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#100f0d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className="antialiased"
        style={{
          backgroundColor: "#100f0d",
          color: "#e7e5e4",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
