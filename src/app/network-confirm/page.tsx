"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Network } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AuthShell } from "@/components/auth-shell";

type State = "working" | "kept" | "late" | "invalid" | "error";

const TEXT: Record<Exclude<State, "working">, { title: string; body: string }> = {
  kept: {
    title: "Network settings kept",
    body: "The appliance answers at this address, so the new settings stay. Sign in here from now on.",
  },
  late: {
    title: "Nothing to confirm",
    body: "No network change is waiting for confirmation. If it took longer than the time allowed, the previous settings are back — sign in at the old address.",
  },
  invalid: {
    title: "Invalid link",
    body: "This confirmation link does not belong to the change waiting for confirmation.",
  },
  error: {
    title: "Could not confirm",
    body: "The appliance did not accept the confirmation. Try reloading this page.",
  },
};

function Confirm() {
  const router = useRouter();
  const token = useSearchParams().get("token") || "";
  const [state, setState] = useState<State>("working");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/appliance/network/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        if (cancelled) return;
        setState(res.ok ? "kept" : res.status === 409 ? "late" : res.status === 400 ? "invalid" : "error");
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state === "working") {
    return (
      <AuthShell>
        <p className="text-sm text-zinc-500">Confirming the network settings...</p>
      </AuthShell>
    );
  }
  const ok = state === "kept";
  const { title, body } = TEXT[state];
  return (
    <AuthShell>
      <Card className="w-full max-w-sm border-0 shadow-none dark:bg-transparent">
        <CardHeader className="text-center">
          <div
            className={`mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full ${
              ok ? "bg-emerald-100 dark:bg-emerald-900/30" : "bg-amber-100 dark:bg-amber-900/30"
            }`}
          >
            <Network className={`h-6 w-6 ${ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`} />
          </div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Button onClick={() => router.push("/login")}>Go to Login</Button>
        </CardContent>
      </Card>
    </AuthShell>
  );
}

export default function NetworkConfirmPage() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <p className="text-sm text-zinc-500">Loading...</p>
        </AuthShell>
      }
    >
      <Confirm />
    </Suspense>
  );
}
