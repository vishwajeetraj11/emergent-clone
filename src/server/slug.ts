const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "to",
  "of",
  "and",
  "or",
  "with",
  "that",
  "this",
  "build",
  "create",
  "make",
  "app",
  "application",
  "please",
  "i",
  "want",
  "need",
  "my",
  "an",
  "some",
  "it",
  "me",
  "us",
  "in",
  "on",
]);

/**
 * Derives a short, Emergent-style project slug from a free-text prompt, e.g.
 * "Build me a quiz app for trivia nights" -> "quiz-trivia-482".
 * Not guaranteed unique on its own — callers retry on a unique-constraint
 * violation with a fresh random suffix (see createProjectAndJob).
 */
export function makeProjectSlug(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !STOPWORDS.has(w));

  const base = (words.length ? words : ["new", "app"]).slice(0, 2).join("-");
  const suffix = String(Math.floor(Math.random() * 900) + 100); // 100-999
  return `${base || "new-app"}-${suffix}`;
}
