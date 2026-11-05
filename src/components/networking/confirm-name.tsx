"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// XenCenter's warning before a bond is made or deleted, with XenMan's own
// safeguard on top: the pool's name typed in, as the server checks it too.

export function ConfirmNameDialog({
  title,
  message,
  confirmName,
  what = "pool's name",
  actionLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmName: string;
  /** What is typed in: the pool's name, or a server's. */
  what?: string;
  actionLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim().toLowerCase() === confirmName.toLowerCase();
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="flex items-start gap-2 whitespace-pre-line">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{message}</span>
          </p>
          <label className="block space-y-1">
            <span>
              Type the {what}, <span className="font-mono font-medium">{confirmName}</span>, to confirm:
            </span>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoFocus />
          </label>
          {error && (
            <p className="flex items-start gap-2 whitespace-pre-line text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="destructive" disabled={!matches || busy} onClick={() => onConfirm(typed.trim())}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {actionLabel}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
