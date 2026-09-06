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
  // Allow the preview origin to access dev-server assets.
  allowedDevOrigins: ["*.space-z.ai", "*.chatglm.cn"],
};

export default nextConfig;
