import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const ICON_BUTTON_CLASSES =
  "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";

/**
 * Small square icon-only button — the same "size-7 … hover:bg-secondary"
 * shape repeated across the preview panel's header controls (viewport
 * toggle, reload, close). `label` doubles as the accessible name and the
 * native title tooltip; `active` applies the pressed/selected styling used
 * by segmented-control-style buttons (e.g. the viewport toggle).
 */
export function IconButton({
  label,
  active,
  className,
  children,
  ...props
}: {
  label: string;
  active?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active ?? undefined}
      className={cn(ICON_BUTTON_CLASSES, active && "bg-secondary text-foreground", className)}
      {...props}
    >
      {children}
    </button>
  );
}
