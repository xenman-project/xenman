"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { XenTaskInfo } from "@/lib/types";
import { useXen } from "@/context/xen-context";

interface TaskContextValue {
  tasks: XenTaskInfo[];
  addTask: (task: Omit<XenTaskInfo, "id" | "status" | "progress" | "createdAt">) => void;
  removeTask: (id: string) => void;
  clearCompleted: () => void;
}

const TaskContext = createContext<TaskContextValue | null>(null);

const STORAGE_KEY = "xenman-pending-tasks";
let taskIdCounter = 0;

function loadPersistedTasks(): XenTaskInfo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: XenTaskInfo[] = JSON.parse(raw);
    // Only restore tasks that were still pending
    const pending = parsed.filter((t) => t.status === "pending");
    // Advance counter past any restored IDs
    for (const t of pending) {
      const num = parseInt(t.id.replace("task-", ""), 10);
      if (num >= taskIdCounter) taskIdCounter = num;
    }
    return pending;
  } catch {
    return [];
  }
}

function persistPendingTasks(tasks: XenTaskInfo[]) {
  try {
    const pending = tasks.filter((t) => t.status === "pending");
    if (pending.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    }
  } catch {
    // Ignore storage errors
  }
}

export function TaskProvider({ children }: { children: React.ReactNode }) {
  const { state, refreshHost } = useXen();
  const [tasks, setTasks] = useState<XenTaskInfo[]>(() => loadPersistedTasks());
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const addTask = useCallback(
    (task: Omit<XenTaskInfo, "id" | "status" | "progress" | "createdAt">) => {
      const newTask: XenTaskInfo = {
        ...task,
        id: `task-${++taskIdCounter}`,
        status: "pending",
        progress: 0,
        createdAt: Date.now(),
      };
      setTasks((prev) => [...prev, newTask]);
    },
    [],
  );

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearCompleted = useCallback(() => {
    setTasks((prev) => prev.filter((t) => t.status === "pending"));
  }, []);

  // Persist pending tasks to localStorage
  useEffect(() => {
    persistPendingTasks(tasks);
  }, [tasks]);

  // Poll pending tasks every 2 seconds
  useEffect(() => {
    const pending = tasks.filter((t) => t.status === "pending");
    if (pending.length === 0) return;

    const interval = setInterval(async () => {
      const current = tasksRef.current.filter((t) => t.status === "pending");
      if (current.length === 0) return;

      for (const task of current) {
        const conn = state.connections[task.hostId];
        if (!conn?.session) continue;

        try {
          const apiHost = conn.connectedVia || conn.host.address;
          const res = await fetch("/api/xen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "task_status",
              host: apiHost,
              port: conn.host.port,
              useSsl: conn.host.useSsl,
              sessionRef: conn.session.sessionRef,
              taskRef: task.taskRef,
            }),
          });

          if (!res.ok) continue;
          const data = await res.json();

          setTasks((prev) =>
            prev.map((t) => {
              if (t.id !== task.id) return t;
              const status = data.status === "success" ? "success"
                : data.status === "failure" ? "failure"
                : data.status === "cancelled" ? "cancelled"
                : "pending";
              return {
                ...t,
                progress: status === "success" ? 1 : Number(data.progress || t.progress),
                status,
                error: data.status === "failure" && data.errorInfo
                  ? (Array.isArray(data.errorInfo) ? data.errorInfo.join(": ") : String(data.errorInfo))
                  : t.error,
              };
            }),
          );

          // Refresh host data on completion
          if (data.status === "success" || data.status === "failure") {
            refreshHost(task.hostId).catch(() => {});
          }
        } catch {
          // Ignore polling errors, will retry next interval
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [tasks, state.connections, refreshHost]);

  // Auto-remove completed/failed tasks after 10 seconds
  useEffect(() => {
    const done = tasks.filter((t) => t.status !== "pending");
    if (done.length === 0) return;

    const timers = done.map((t) => {
      const elapsed = Date.now() - t.createdAt;
      const delay = Math.max(0, 10000 - elapsed);
      return setTimeout(() => {
        setTasks((prev) => prev.filter((p) => p.id !== t.id));
      }, delay);
    });

    return () => timers.forEach(clearTimeout);
  }, [tasks]);

  return (
    <TaskContext.Provider value={{ tasks, addTask, removeTask, clearCompleted }}>
      {children}
    </TaskContext.Provider>
  );
}

export function useTask() {
  const ctx = useContext(TaskContext);
  if (!ctx) throw new Error("useTask must be used within TaskProvider");
  return ctx;
}
