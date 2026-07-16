import { NextResponse } from "next/server";
import { getCurrentUser, isClerkConfigured } from "@/lib/auth";
import { DEV_USER } from "@/lib/dev-user";
import {
  ensureSignupBonus,
  ensureUserRow,
  getUserCreditBalance,
} from "@/server/credits";

// ---------------------------------------------------------------------------
// Phase 4 (Half A, REAL): GET /api/credits — the current user's real credit
// balance (sum of their credit_ledger rows). Same isClerkConfigured() /
// DEV_USER gate as src/server/jobs.ts's createProjectAndJob, so this works
// standalone even before any project has ever been created in this
// environment (e.g. right after a fresh `npm run dev`, before the first
// prompt is submitted).
// ---------------------------------------------------------------------------

export async function GET() {
  let userId: string;
  if (isClerkConfigured()) {
    const user = await getCurrentUser();
    userId = user.id;
  } else {
    await ensureUserRow({
      id: DEV_USER.id,
      email: DEV_USER.email,
      name: DEV_USER.name,
    });
    userId = DEV_USER.id;
  }

  await ensureSignupBonus(userId);
  const balance = await getUserCreditBalance(userId);
  return NextResponse.json({ balance });
}
