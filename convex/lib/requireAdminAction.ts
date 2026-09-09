import { getAuthUserId } from "@convex-dev/auth/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

export async function requireAdminAction(ctx: ActionCtx): Promise<void> {
  const userId = await getAuthUserId(ctx);
  if (!userId || !(await ctx.runQuery(internal.lib.adminAuth._checkAdminRole, { userId })))
    throw new Error("Admin access required");
}
