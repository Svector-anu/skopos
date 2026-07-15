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
  async redirects() {
    return [
      // app/docs/page.tsx was removed — docs now live at docs.tryskopos.xyz.
      // Old links/bookmarks to the in-app page should land there, not 404.
      { source: "/docs", destination: "https://docs.tryskopos.xyz", permanent: true },
    ];
  },
};

export default nextConfig;
