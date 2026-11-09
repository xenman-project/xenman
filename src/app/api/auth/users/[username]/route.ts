import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import {
  updateUserRole,
  updateUserEmail,
  resetUserPassword,
  deleteUser,
  validatePassword,
  listUsers,
  setUserPools,
  type UserRole,
} from "@/lib/auth";
import { auditRequest } from "@/lib/audit";
import { removeSessionsForActor } from "@/lib/xen-sessions";
import { endUserSessions } from "@/lib/login-sessions";

/** Every sign-in of a user ended, and the pool connections opened with them. */
function signOutEverywhere(username: string): number {
  const ended = endUserSessions(username);
  removeSessionsForActor(username);
  return ended;
}

/** Snapshot of a user before modification, so entries can log before → after. */
function currentUser(username: string) {
  return listUsers().find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  try {
    const { username } = await params;
    const body = await request.json();
    const { role, newPassword, email, pools, signOut } = body;

    const before = currentUser(username);

    if (pools !== undefined) {
      if (!Array.isArray(pools) || pools.some((p) => typeof p !== "string")) {
        return NextResponse.json(
          { error: "pools must be an array of host ids" },
          { status: 400 },
        );
      }
      const result = setUserPools(username, pools as string[]);
      if (!result.success) {
        auditRequest(request, {
          category: "user",
          action: "user_pools_changed",
          target: `user ${username}`,
          outcome: "failure",
          detail: result.error,
        });
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      // No need to drop live sessions: /api/xen re-checks the grant on every
      // request, so a revoked pool stops working at once while pools the user
      // still holds keep running.
      const previous = before?.pools ?? [];
      auditRequest(request, {
        category: "user",
        action: "user_pools_changed",
        target: `user ${username}`,
        outcome: "success",
        detail: `${previous.length ? previous.join(", ") : "(none)"} → ${
          pools.length ? (pools as string[]).join(", ") : "(none)"
        }`,
      });
    }

    if (email !== undefined) {
      const result = updateUserEmail(username, email);
      if (!result.success) {
        auditRequest(request, {
          category: "user",
          action: "user_email_changed",
          target: `user ${username}`,
          outcome: "failure",
          detail: result.error,
        });
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      auditRequest(request, {
        category: "user",
        action: "user_email_changed",
        target: `user ${username}`,
        outcome: "success",
        detail: `${before?.email || "(none)"} → ${email || "(none)"}`,
      });
    }

    if (role) {
      if (!["admin", "operator", "viewer"].includes(role)) {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      }
      const result = updateUserRole(
        username,
        role as UserRole,
        auth.payload.sub,
      );
      if (!result.success) {
        auditRequest(request, {
          category: "user",
          action: "user_role_changed",
          target: `user ${username}`,
          outcome: "failure",
          detail: result.error,
        });
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      auditRequest(request, {
        category: "user",
        action: "user_role_changed",
        target: `user ${username}`,
        outcome: "success",
        detail: `${before?.role ?? "?"} → ${role}`,
      });
    }

    if (newPassword) {
      const pwError = validatePassword(newPassword);
      if (pwError) {
        return NextResponse.json({ error: pwError }, { status: 400 });
      }
      const result = resetUserPassword(username, newPassword);
      const ended = result.success ? signOutEverywhere(username) : 0;
      if (!result.success) {
        auditRequest(request, {
          category: "user",
          action: "user_password_reset",
          target: `user ${username}`,
          outcome: "failure",
          detail: result.error,
        });
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      auditRequest(request, {
        category: "user",
        action: "user_password_reset",
        target: `user ${username}`,
        outcome: "success",
        detail: `Password set by administrator${ended ? `, ${ended} sign-in(s) ended` : ""}`,
      });
    }

    if (signOut === true) {
      if (!before) return NextResponse.json({ error: "User not found" }, { status: 404 });
      const ended = signOutEverywhere(username);
      auditRequest(request, {
        category: "user",
        action: "user_signed_out",
        target: `user ${username}`,
        outcome: "success",
        detail: `${ended} sign-in(s) ended`,
      });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  try {
    const { username } = await params;
    const before = currentUser(username);
    const result = deleteUser(username, auth.payload.sub);
    if (!result.success) {
      auditRequest(request, {
        category: "user",
        action: "user_deleted",
        target: `user ${username}`,
        outcome: "failure",
        detail: result.error,
      });
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    // The account is gone — its sign-ins and the XAPI sessions bound to it too.
    endUserSessions(username);
    const dropped = removeSessionsForActor(username);
    auditRequest(request, {
      category: "user",
      action: "user_deleted",
      target: `user ${username}`,
      outcome: "success",
      detail: [
        before ? `had role ${before.role}` : null,
        dropped ? `${dropped} session(s) dropped` : null,
      ]
        .filter(Boolean)
        .join(", ") || undefined,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
