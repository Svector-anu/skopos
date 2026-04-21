import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  async rewrites() {
    return [
      { source: "/skopos-logo.png", destination: "/api/logo" },
    ];
  },
};

export default nextConfig;
