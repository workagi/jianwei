import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: { root: __dirname },
  experimental: { cpus: 2, webpackMemoryOptimizations: true },
};

export default nextConfig;
