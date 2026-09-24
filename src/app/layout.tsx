import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // v1.14.2: the title states what the product is — a Windows desktop app
  // (the browser route is a landing page / dev preview, not the product).
  title: "FrameFuse v1.14.5 — Windows Desktop Video Studio",
  description:
    "Multi-track Windows desktop video studio: video clips, green-screen chroma key with on-canvas PiP, background music with volume & loop, SFX, native Whisper captions, and fast parallel FFmpeg export.",
  applicationName: "FrameFuse",
  // v7 FIX B: browser-tab icons come from the App Router file conventions —
  // src/app/icon.ico (multi-size DIB/PNG build) + src/app/apple-icon.png.
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className="antialiased"
        style={{
          backgroundColor: "#0a0a0a",
          color: "#e4e4e7",
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
