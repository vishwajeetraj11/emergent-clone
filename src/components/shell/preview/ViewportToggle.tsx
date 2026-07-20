import type { LucideIcon } from "lucide-react";
import { Monitor, Smartphone, Tablet } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";

export type Viewport = "desktop" | "tablet" | "phone";

// Single source of truth for both the header's viewport buttons and the
// device frame's max-width (see viewportMaxWidth below) — desktop renders
// the iframe full-bleed (no cap); tablet/phone cap it at their listed
// width.
const VIEWPORTS: {
  mode: Viewport;
  icon: LucideIcon;
  label: string;
  maxWidth?: number;
}[] = [
  { mode: "desktop", icon: Monitor, label: "Desktop width" },
  { mode: "tablet", icon: Tablet, label: "Tablet width (768px)", maxWidth: 768 },
  { mode: "phone", icon: Smartphone, label: "Phone width (390px)", maxWidth: 390 },
];

/** The device-frame max-width (px) for a viewport mode — `undefined` for
 * desktop, which renders the iframe full-bleed with no cap. */
export function viewportMaxWidth(viewport: Viewport): number | undefined {
  return VIEWPORTS.find((v) => v.mode === viewport)?.maxWidth;
}

/** Header segmented control for switching the preview iframe's device
 * width — desktop/tablet/phone. */
export function ViewportToggle({
  viewport,
  onChange,
}: {
  viewport: Viewport;
  onChange: (viewport: Viewport) => void;
}) {
  return (
    <div className="mr-1 flex items-center gap-0.5" role="group" aria-label="Preview width">
      {VIEWPORTS.map(({ mode, icon: Icon, label }) => (
        <IconButton
          key={mode}
          label={label}
          active={viewport === mode}
          onClick={() => onChange(mode)}
        >
          <Icon className="size-3.5" />
        </IconButton>
      ))}
    </div>
  );
}
