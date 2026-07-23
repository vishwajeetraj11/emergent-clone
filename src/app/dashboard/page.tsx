import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { AppShell } from "@/components/shell/AppShell";

/**
 * The builder itself. `/` is the marketing landing page for everyone, so a
 * signed-in user following a shared link to the root still sees what the
 * product is rather than getting silently swapped onto their own dashboard.
 *
 * Signed-out visitors are sent to sign-in rather than shown an empty shell,
 * since every API call this page makes would 404 on ownership anyway.
 */
export default async function Dashboard() {
  const { userId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }

  return <AppShell />;
}
