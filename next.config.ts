import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export so Electron can load the built UI from out/index.html
  output: "export",
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
