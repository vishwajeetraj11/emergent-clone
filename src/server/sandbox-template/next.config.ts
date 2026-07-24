import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next dev blocks cross-origin requests to dev-only assets/endpoints by
  // default (see node_modules/next/dist/docs/.../allowedDevOrigins.md). The
  // preview iframe reaches this dev server on the public sb-*.vercel.run
  // domain the sandbox exposes, not the localhost the server booted as.
  // Without this allowance the page's static HTML/chunks load but the
  // client-side boot stalls silently before hydration: no console error, dead
  // buttons, empty client-rendered content (exactly how it first failed).
  allowedDevOrigins: ["*.vercel.run"],
};

export default nextConfig;
