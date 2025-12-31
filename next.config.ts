import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/mcp/:path*", destination: "/api/mcp/:path*" },
      ],
    };
  },
};

export default nextConfig;
