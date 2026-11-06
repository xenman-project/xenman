"use client";

import React, { useState } from "react";
import { useTask } from "@/context/task-context";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ListTodo,
  ArrowRightLeft,
  Wrench,
  CheckCircle2,
  Copy,
  XCircle,
  X,
} from "lucide-react";
import { XenTaskInfo } from "@/lib/types";

function TaskIcon({ type }: { type: XenTaskInfo["type"] }) {
  if (type === "vm_migrate") return <ArrowRightLeft className="h-4 w-4 shrink-0 text-blue-500" />;
  if (type === "vm_copy") return <Copy className="h-4 w-4 shrink-0 text-blue-500" />;
  return <Wrench className="h-4 w-4 shrink-0 text-amber-500" />;
}

function StatusIcon({ status }: { status: XenTaskInfo["status"] }) {
  if (status === "success") return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (status === "failure") return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
  return null;
}

function TaskItem({ task }: { task: XenTaskInfo }) {
  const pct = Math.round(task.progress * 100);

  return (
    <div className="space-y-1.5 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        {task.status === "pending" ? (
          <TaskIcon type={task.type} />
        ) : (
          <StatusIcon status={task.status} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
            {task.label}
          </p>
          {task.description && (
            <p className="truncate text-[10px] text-zinc-500">
              {task.description}
            </p>
          )}
        </div>
        {task.status === "pending" && (
          <span className="shrink-0 text-[10px] font-mono text-zinc-400">
            {pct}%
          </span>
        )}
        {task.status !== "pending" && (
          <Badge
            variant="outline"
            className={`shrink-0 text-[9px] px-1.5 py-0 ${
              task.status === "success"
                ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                : "bg-red-500/10 text-red-600 border-red-500/20"
            }`}
          >
            {task.status === "success" ? "Done" : "Failed"}
          </Badge>
        )}
      </div>
      {task.status === "pending" && (
        <Progress value={pct} className="h-1.5" />
      )}
      {task.status === "failure" && task.error && (
        <p className="text-[10px] text-red-500 line-clamp-2">{task.error}</p>
      )}
    </div>
  );
}

export function TaskWidget() {
  const { tasks, clearCompleted } = useTask();
  const [open, setOpen] = useState(false);

  if (tasks.length === 0) return null;

  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  const hasCompleted = tasks.some((t) => t.status !== "pending");

  return (
    <div className="relative">
      {/* Panel — absolute so opening it never shifts the trigger row. Bounded
          against the viewport for the same reason as the alert bell: a
          max-height on <ScrollArea> does not clip, its root sets no overflow. */}
      {open && (
        <div className="absolute bottom-full right-0 mb-2 flex max-h-[70vh] w-80 flex-col rounded-lg border border-zinc-200 bg-white shadow-lg max-md:fixed max-md:inset-x-3 max-md:bottom-16 max-md:mb-0 max-md:w-auto dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
              Tasks
            </span>
            <div className="flex items-center gap-1">
              {hasCompleted && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px] text-zinc-400"
                  onClick={clearCompleted}
                >
                  Clear done
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-zinc-400"
                onClick={() => setOpen(false)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
          {/* min-h-0 lets this flex child shrink below its content height. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-2 p-2">
              {tasks.map((task) => (
                <TaskItem key={task.id} task={task} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Trigger Button */}
      <Button
        size="sm"
        variant="outline"
        className="h-9 gap-2 rounded-full border-zinc-300 bg-white shadow-md dark:border-zinc-700 dark:bg-zinc-900"
        onClick={() => setOpen((o) => !o)}
      >
        <ListTodo className="h-4 w-4" />
        {pendingCount > 0 ? (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-medium text-white">
            {pendingCount}
          </span>
        ) : (
          <span className="text-xs text-zinc-500">{tasks.length}</span>
        )}
      </Button>
    </div>
  );
}
