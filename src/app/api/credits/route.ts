import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { ensureSignupBonus, getUserCreditBalance } from "@/server/credits";

// ---------------------------------------------------------------------------
// GET /api/credits — the current user's real credit balance (sum of their
// credit_ledger rows). getCurrentUser() provisions the `users` row on first
// authenticated request, so this works standalone before any project has ever
// been created.
// ---------------------------------------------------------------------------

export async function GET() {
  const { id: userId } = await getCurrentUser();

  await ensureSignupBonus(userId);
  const balance = await getUserCreditBalance(userId);
  return NextResponse.json({ balance });
}
