export type OnboardingSlide = {
  title: string;
  subtitle: string;
};

export const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    title: "Deploy Your Application",
    subtitle:
      "Ship straight to production with a single click once your app is ready.",
  },
  {
    title: "1M Context Window",
    subtitle:
      "Your agent keeps the entire build in view — every file, every decision.",
  },
  {
    title: "Manage Agent Context With Forks",
    subtitle:
      "Branch a session to explore an idea without losing your working version.",
  },
  {
    title: "Assets",
    subtitle:
      "Drop in images, documents, and references for the agent to build with.",
  },
];

export const ONBOARDING_AUTO_ADVANCE_MS = 4500;
