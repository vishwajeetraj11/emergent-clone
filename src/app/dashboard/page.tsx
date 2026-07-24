import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { AppShell } from "@/components/shell/AppShell";

/**
 * The builder. Signed-out visitors go to sign-in rather than an empty shell,
 * since every API call this page makes would 404 on ownership anyway.
 */
export default async function Dashboard() {
  const { userId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }

  return <AppShell />;
}
