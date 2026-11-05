"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type UserRole = "admin" | "operator" | "viewer";

interface AuthContextValue {
  username: string | null;
  role: UserRole | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchMe() {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        setUsername(data.username);
        setRole(data.role);
      } else {
        setUsername(null);
        setRole(null);
      }
    } catch {
      setUsername(null);
      setRole(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchMe();
  }, []);

  return (
    <AuthContext.Provider value={{ username, role, loading, refetch: fetchMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
