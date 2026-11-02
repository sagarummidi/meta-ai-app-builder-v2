import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/sandpack",
        destination: "/sandpack/index.html",
      },
      {
        source: "/sandpack/",
        destination: "/sandpack/index.html",
      },
      {
        source: "/static/:path*",
        destination: "/sandpack/static/:path*",
      },
      {
        source: "/:file(.*\\.worker\\.js)",
        destination: "/sandpack/:file",
      },
    ];
  },
};

export default nextConfig;
