import { redirect } from "next/navigation";
import { LandingPage } from "@/components/marketing/LandingPage";
import { isClerkConfigured } from "@/lib/auth";

/**
 * `/` is the marketing landing page — for everyone, signed in or not. The
 * builder lives at /dashboard.
 *
 * It used to be the other way round: `/` rendered AppShell and only showed
 * LandingPage to signed-out visitors. That made the root mean two different
 * things depending on who was looking, so a link to the product's front door
 * showed an existing user their own dashboard instead of the pitch.
 *
 * Unconfigured (dev, default) is the one exception: with no Clerk keys there
 * is no sign-in/up flow behind the landing page's CTAs, so every button on it
 * would dead-end. That mode redirects straight to the builder, preserving the
 * single-user dev experience this route had before.
 */
export default function Home() {
  if (!isClerkConfigured()) {
    redirect("/dashboard");
  }

  return <LandingPage />;
}
