"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";

export interface ChecklistOption {
  value: string;
  label: string;
  /** Shown greyed after the label, e.g. a row count. */
  hint?: string;
}

/**
 * XenCenter's "Filter by …" control: a dropdown of checkboxes that starts with
 * everything selected, so filtering means *unchecking* what you do not want
 * rather than picking what you do. The trigger reports the deviation — plain
 * label while everything is on, label plus a count once something is off — so a
 * narrowed list can never look like a complete one.
 */
export function FilterChecklist({
  label,
  options,
  selected,
  onChange,
  className,
}: {
  label: string;
  options: ChecklistOption[];
  /** Selected values. Every option selected is the neutral state. */
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  className?: string;
}) {
  const allValues = options.map((o) => o.value);
  const allOn = allValues.length > 0 && allValues.every((v) => selected.has(v));

  function toggle(value: string) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`h-8 justify-between gap-1.5 text-xs font-normal ${className ?? ""}`}
        >
          <span className={allOn ? "text-zinc-600 dark:text-zinc-300" : "font-medium"}>
            {label}
            {allOn ? "" : ` (${selected.size}/${allValues.length})`}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-zinc-400" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {options.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs">
            Nothing to filter
          </DropdownMenuItem>
        ) : (
          <>
            {options.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={selected.has(option.value)}
                onCheckedChange={() => toggle(option.value)}
                // Keep the menu open: unchecking several levels in a row is the
                // normal way to use this.
                onSelect={(e) => e.preventDefault()}
                className="text-xs"
              >
                {option.label}
                {option.hint && (
                  <span className="ml-1.5 text-[10px] text-zinc-400">{option.hint}</span>
                )}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-xs"
              onSelect={(e) => {
                e.preventDefault();
                onChange(new Set(allValues));
              }}
            >
              Select all
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-xs"
              onSelect={(e) => {
                e.preventDefault();
                onChange(new Set());
              }}
            >
              Clear selection
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
