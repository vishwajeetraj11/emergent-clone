import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { isClerkConfigured } from "@/lib/auth";

/**
 * The builder itself, which used to live at `/`. Moved here so `/` can be
 * the marketing landing page for everyone rather than only for signed-out
 * visitors — a signed-in user following a shared link to the root should
 * still see what the product is, not get silently swapped onto their own
 * dashboard.
 *
 * Unconfigured (dev, default): renders AppShell with DEV_USER, no auth to
 * check — same single-user mode the root route had. Configured: signed-out
 * visitors are sent to sign-in rather than shown an empty shell, since every
 * API call this page makes would 404 on ownership anyway.
 */
export default async function Dashboard() {
  if (!isClerkConfigured()) {
    return <AppShell />;
  }

  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }

  return <AppShell />;
}
