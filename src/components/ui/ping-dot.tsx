/**
 * Small emerald "ping" indicator — an animated outer ring plus a solid
 * inner dot — used wherever the preview panel needs a lightweight
 * still-working signal (restoring the sandbox, waiting for the iframe's
 * first paint).
 */
export function PingDot() {
  return (
    <span className="relative flex size-2">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60 opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
    </span>
  );
}
