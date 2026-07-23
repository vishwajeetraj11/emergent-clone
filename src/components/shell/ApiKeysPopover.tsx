"use client";

import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  clearUserApiKeys,
  loadUserApiKeys,
  saveUserApiKeys,
  type UserApiKeys,
} from "@/lib/user-keys-storage";

/**
 * BYOK (bring-your-own-key) composer control: lets the user paste their own
 * Anthropic/OpenAI API key so their builds bill their key instead of the
 * platform's (see src/lib/user-keys-storage.ts for the sessionStorage
 * contract, src/server/user-keys.ts for the server side). A plain
 * useState-toggled, absolutely-positioned panel rather than
 * ui/dropdown-menu's Base UI Menu primitive — Menu manages focus/keyboard
 * behavior for selectable items (arrow-key navigation, type-ahead search),
 * which fights normal typing into a password input — but it borrows
 * SessionSwitcher/DeploymentHistory's shape otherwise (ChatPanel.tsx): a
 * lazily-populated open/closed panel anchored under an icon-only trigger.
 * Anchored to the trigger's right edge (not left, unlike those two): this
 * sits in the composer's right-hand cluster next to the model picker, so a
 * left-anchored panel would grow off the edge of this narrow sidebar.
 */
export function ApiKeysPopover({
  onChange,
}: {
  /** Fired after Save/Clear with the freshly-stored keys, so ChatPanel can re-filter the model picker. */
  onChange?: (keys: UserApiKeys) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  // Lazy initializer (runs once, during this component's first render) —
  // not a mount effect, so there's no setState-in-effect to derive here.
  // SSR has no `window` (see loadUserApiKeys's guard), so server-rendered
  // HTML always starts "false"; the real browser's first client render
  // (hydration) computes the true value immediately after. That one-time
  // divergence only affects IconButton's cosmetic `active` styling below —
  // see suppressHydrationWarning there — never layout or content anything
  // else hydrates against.
  const [hasAnyKey, setHasAnyKey] = useState(() => {
    const stored = loadUserApiKeys();
    return Boolean(stored.anthropic || stored.openai);
  });
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Focus management for the panel (see the effect below). `triggerRef` is
  // where focus goes back to on close; `firstFieldRef` is where it lands on
  // open.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  /**
   * Re-syncs the draft fields from storage right as the popover opens (not
   * just on mount, so anything saved from another tab/reload in between is
   * picked up) — done here, in the click handler itself, rather than a
   * `useEffect` keyed on `open`: this IS the user action that should trigger
   * the read, so there's nothing to "synchronize" after the fact.
   */
  function handleToggleOpen() {
    setOpen((prevOpen) => {
      const next = !prevOpen;
      if (next) {
        const stored = loadUserApiKeys();
        setAnthropicKey(stored.anthropic ?? "");
        setOpenaiKey(stored.openai ?? "");
      }
      return next;
    });
  }

  useEffect(() => {
    if (!open) return;
    function onOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Escape must not strand focus on a node that just unmounted —
      // browsers reset it to <body>, which drops a keyboard user back at the
      // top of the document. Put it back where they opened this from.
      triggerRef.current?.focus();
    }
    document.addEventListener("mousedown", onOutsideClick);
    document.addEventListener("keydown", onEscape);
    // Pull focus into the panel on open. Without it the panel appears
    // visually but focus stays on the trigger, so the next Tab continues
    // past it into the rest of the composer and the fields are only
    // reachable by shift-tabbing backwards from somewhere unrelated.
    firstFieldRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onOutsideClick);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  /** Closes the panel and hands focus back to the trigger — same reason as
   * the Escape handler above: the panel unmounts, and focus left on a
   * removed node falls back to <body>. */
  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleSave() {
    const next: UserApiKeys = {};
    const trimmedAnthropic = anthropicKey.trim();
    const trimmedOpenai = openaiKey.trim();
    if (trimmedAnthropic) next.anthropic = trimmedAnthropic;
    if (trimmedOpenai) next.openai = trimmedOpenai;
    saveUserApiKeys(next);
    setHasAnyKey(Boolean(next.anthropic || next.openai));
    onChange?.(next);
    closeAndRestoreFocus();
  }

  function handleClear() {
    clearUserApiKeys();
    setAnthropicKey("");
    setOpenaiKey("");
    setHasAnyKey(false);
    onChange?.({});
  }

  return (
    <div ref={containerRef} className="relative">
      <IconButton
        ref={triggerRef}
        // The name carries the stored-key state, because `active` can't:
        // it means "a key is stored", NOT "this popover is open", and
        // IconButton renders it as aria-pressed — which, on a control that
        // opens a panel, reads as the open state and contradicts
        // aria-expanded. So aria-pressed is suppressed here and the fact
        // moves into the label, where it can't be misread.
        label={
          hasAnyKey
            ? "Your API keys (BYOK) — a key is saved"
            : "Your API keys (BYOK) — no key saved"
        }
        active={hasAnyKey}
        aria-pressed={undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        // See hasAnyKey's lazy initializer above for why this one attribute
        // can legitimately differ between the server-rendered HTML and this
        // component's first client render.
        suppressHydrationWarning
        onClick={handleToggleOpen}
      >
        <KeyRound className="size-4" />
      </IconButton>
      {open && (
        <div
          role="dialog"
          aria-label="Your API keys"
          className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <p className="mb-2 text-xs font-medium text-foreground">Your API keys</p>
          <div className="flex flex-col gap-2">
            {/* Explicit htmlFor/id rather than relying on the label
                wrapping the control: <Input> is a component, so nothing —
                not the linter, and not every AT implementation walking a
                portal'd or wrapped DOM — can be sure a real <input> ends up
                inside. An id pairing is unambiguous either way. */}
            <label
              htmlFor="byok-anthropic-key"
              className="flex flex-col gap-1 text-xs text-muted-foreground"
            >
              Anthropic API key
              <Input
                id="byok-anthropic-key"
                ref={firstFieldRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder="sk-ant-…"
              />
            </label>
            <label
              htmlFor="byok-openai-key"
              className="flex flex-col gap-1 text-xs text-muted-foreground"
            >
              OpenAI API key
              <Input
                id="byok-openai-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                placeholder="sk-…"
              />
            </label>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            Stored only in this browser tab. Sent only with your builds — never saved on the server.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={handleClear}>
              Clear
            </Button>
            <Button size="sm" onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
