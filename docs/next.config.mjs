import { createGeistdocs } from "@vercel/geistdocs/next";

const withGeistdocs = createGeistdocs();
const legacySlugs = ["quickstart", "coverage", "dependencies", "ffi", "native-objects", "wasm", "platforms", "cli", "how-it-works", "limitations"];

/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  skipProxyUrlNormalize: true,
  async redirects() {
    return [
      { source: "/introduction", destination: "/docs", permanent: true },
      { source: "/docs/introduction", destination: "/docs", permanent: true },
      ...legacySlugs.map((slug) => ({ source: `/${slug}`, destination: `/docs/${slug}`, permanent: true })),
    ];
  },
  outputFileTracingIncludes: { "/og/[...slug]": ["./public/*.ttf"], "/og": ["./public/*.ttf"] },
};

export default withGeistdocs(nextConfig);
