import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next dev blocks cross-origin requests to dev-only assets/endpoints by
  // default (see node_modules/next/dist/docs/.../allowedDevOrigins.md). The
  // preview iframe reaches this dev server through whatever host the sandbox
  // provider exposes — for VercelSandboxProvider that's a public
  // sb-*.vercel.run domain, not the localhost the server booted as. Without
  // this allowance the page's static HTML/chunks load but the client-side
  // boot stalls silently before hydration: no console error, dead
  // buttons, empty client-rendered content (exactly how it first failed).
  // Harmless for the local provider (same-origin localhost never consults
  // this list).
  allowedDevOrigins: ["*.vercel.run"],
};

export default nextConfig;
