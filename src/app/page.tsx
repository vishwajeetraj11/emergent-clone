import { AppShell } from "@/components/shell/AppShell";
import { LandingPage } from "@/components/marketing/LandingPage";
import { isClerkConfigured } from "@/lib/auth";

/**
 * Unconfigured (dev, default): straight to AppShell, single-user DEV_USER —
 * unchanged from Phase 0-2. Configured: signed-out visitors get the
 * marketing landing page instead of the dashboard; signed-in visitors get
 * AppShell, same as before.
 */
export default async function Home() {
  if (!isClerkConfigured()) {
    return <AppShell />;
  }

  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) {
    return <LandingPage />;
  }

  return <AppShell />;
}
