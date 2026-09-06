import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export so Electron can load the built UI from out/index.html
  output: "export",
  // Use relative paths so assets load correctly via file:// protocol in Electron
  // Without this, /_next/ resolves to filesystem root (C:\_next\) instead of app dir
  assetPrefix: "./",
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
