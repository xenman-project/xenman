"use client";

import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AuthShell } from "@/components/auth-shell";
import { TotpEnrol } from "@/components/totp-settings";

/**
 * Where a sign-in lands when the two-factor policy covers the account and it
 * has not been set up: nothing else in XenMan opens until it is (proxy.ts).
 */
export default function SetupTwoFactorPage() {
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/signed-out";
  }

  return (
    <AuthShell>
      <Card className="w-full max-w-md border-0 shadow-none dark:bg-transparent">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
            <ShieldCheck className="h-6 w-6 text-zinc-600 dark:text-zinc-400" />
          </div>
          <CardTitle>Set up two-factor sign-in</CardTitle>
          <CardDescription>
            Your administrator requires a code from an authenticator app at every sign-in. Set it up before you continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {/* A full load at the end: the session is no longer limited to this page. */}
          <TotpEnrol onDone={() => window.location.assign("/")} />
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
