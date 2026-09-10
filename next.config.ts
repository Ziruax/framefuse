import type { NextConfig } from "next";

// Dev mode must NOT use output:"export" — Next 16 dev + export produces an
// incomplete RSC flight stream (page row serializes as null) so the client
// never hydrates and the whole app is dead HTML. The export config is only
// needed for the production static build that Electron loads via file://.
// `next dev` sets NODE_ENV=development, `next build` sets production.
const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  // Static export so Electron can load the built UI from out/index.html
  ...(isDev ? {} : { output: "export" as const }),
  // Use relative paths so assets load correctly via file:// protocol in Electron
  // Without this, /_next/ resolves to filesystem root (C:\_next\) instead of app dir
  ...(isDev ? {} : { assetPrefix: "./" }),
  images: {
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Fix "ignored package-lock.json in home directory" warning on Windows
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
