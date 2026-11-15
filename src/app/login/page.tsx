"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthHeading, AuthShell } from "@/components/auth-shell";

// The sign-in form's controls: small bold
// labels, slim fields, a rounded petrol button.
const LABEL = "text-xs font-semibold text-zinc-800 dark:text-zinc-200";
const FIELD = "h-8 rounded-sm text-sm";
const SUBMIT = "h-8 w-full rounded-full bg-[#05758a] text-xs font-semibold text-white hover:bg-[#04677a] disabled:opacity-50";
const LINK = "text-xs text-[var(--shell-link)] underline-offset-2 hover:underline";

// The address this XenMan is reached at, named like a controller. Read
// in the browser only: the server cannot know which name the user typed.
const noSubscribe = () => () => {};
function useServerAddress() {
  return useSyncExternalStore(noSubscribe, () => window.location.host, () => "");
}

export default function LoginPage() {
  const serverAddress = useServerAddress();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Two-factor sign-in: the code after the password (api/auth/login/totp).
  const [totpMode, setTotpMode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");

  // Forgot password
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotInput, setForgotInput] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Login failed");
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (data.totpRequired) {
        setTotpMode(true);
        setUseRecovery(false);
        setCode("");
        return;
      }
      signedIn(data);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  function signedIn(data: { mustChangePassword?: boolean; recoveryLeft?: number }) {
    if (data.mustChangePassword) {
      router.push("/change-password");
      return;
    }
    // Few recovery codes left: said once, on the way in.
    if (typeof data.recoveryLeft === "number" && data.recoveryLeft <= 3) {
      window.alert(
        `You signed in with a recovery code. ${data.recoveryLeft} left -- make new ones under Settings > Account.`,
      );
    }
    router.push("/");
    router.refresh();
  }

  async function handleCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login/totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(useRecovery ? { recoveryCode: code } : { code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Sign-in failed");
        setCode("");
        if (data.restart) {
          setTotpMode(false);
          setPassword("");
        }
        return;
      }
      signedIn(data);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotError("");
    setForgotLoading(true);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernameOrEmail: forgotInput }),
      });
      if (!res.ok) {
        const data = await res.json();
        setForgotError(data.error || "Request failed");
        return;
      }
      setForgotSent(true);
    } catch {
      setForgotError("Network error");
    } finally {
      setForgotLoading(false);
    }
  }

  if (totpMode) {
    return (
      <AuthShell>
        <div className="w-full max-w-[19rem]">
          <AuthHeading
            title="Two-factor sign-in"
            subtitle={
              useRecovery
                ? "Enter one of your recovery codes. Each one works once."
                : "Enter the code from your authenticator app."
            }
          />
          <form onSubmit={handleCode} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="totp-code" className={LABEL}>
                {useRecovery ? "Recovery code" : "Authentication code"}
              </Label>
              <Input
                id="totp-code"
                key={useRecovery ? "recovery" : "code"}
                value={code}
                onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, "").slice(0, 6))}
                className={`${FIELD} font-mono tracking-widest`}
                inputMode={useRecovery ? "text" : "numeric"}
                autoComplete="one-time-code"
                placeholder={useRecovery ? "xxxx-xxxx" : "123456"}
                autoFocus
              />
            </div>
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <Button
              type="submit"
              disabled={loading || (useRecovery ? code.trim().length < 8 : code.length !== 6)}
              className={`mt-1 ${SUBMIT}`}
            >
              {loading ? "Checking..." : "Verify"}
            </Button>
            <button
              type="button"
              className={LINK}
              onClick={() => {
                setUseRecovery(!useRecovery);
                setCode("");
                setError("");
              }}
            >
              {useRecovery ? "Use the code from the app" : "Use a recovery code"}
            </button>
            <button
              type="button"
              className={LINK}
              onClick={() => {
                setTotpMode(false);
                setPassword("");
                setCode("");
                setError("");
              }}
            >
              Back to sign in
            </button>
          </form>
        </div>
      </AuthShell>
    );
  }

  if (forgotMode) {
    return (
      <AuthShell>
        <div className="w-full max-w-[19rem]">
          <AuthHeading
            title="Forgot password"
            subtitle={
              forgotSent
                ? "If an account with that username or email exists, a reset link has been sent."
                : "Enter your username or email address to receive a password reset link."
            }
          />
          {forgotSent ? (
            <div className="text-center">
              <button
                type="button"
                className={LINK}
                onClick={() => {
                  setForgotMode(false);
                  setForgotSent(false);
                  setForgotInput("");
                }}
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={handleForgot} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="forgot-input" className={LABEL}>User name or email</Label>
                <Input
                  id="forgot-input"
                  value={forgotInput}
                  onChange={(e) => {
                    setForgotInput(e.target.value);
                    setForgotError("");
                  }}
                  className={FIELD}
                  autoFocus
                />
              </div>
              {forgotError && (
                <p className="text-xs text-red-600 dark:text-red-400">{forgotError}</p>
              )}
              <Button type="submit" disabled={forgotLoading || !forgotInput} className={SUBMIT}>
                {forgotLoading ? "Sending..." : "Send reset link"}
              </Button>
              <button
                type="button"
                className={LINK}
                onClick={() => {
                  setForgotMode(false);
                  setForgotError("");
                  setForgotInput("");
                }}
              >
                Back to sign in
              </button>
            </form>
          )}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="w-full max-w-[19rem]">
        <AuthHeading
          title="XenMan"
          subtitle={serverAddress ? `Connected server: ${serverAddress}` : " "}
        />
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="username" className={LABEL}>User name or email</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={FIELD}
              autoFocus
              autoComplete="username"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password" className={LABEL}>Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={FIELD}
              autoComplete="current-password"
            />
          </div>
          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}
          <Button type="submit" disabled={loading || !username || !password} className={`mt-1 ${SUBMIT}`}>
            {loading ? "Signing in..." : "Sign in"}
          </Button>
          <button
            type="button"
            className={LINK}
            onClick={() => {
              setForgotMode(true);
              setForgotInput(username);
              setForgotSent(false);
              setForgotError("");
            }}
          >
            Forgot password?
          </button>
        </form>
      </div>
    </AuthShell>
  );
}
