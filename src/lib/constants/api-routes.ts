/**
 * Every internal API path the client calls, in one place. Parameterised routes
 * are functions so an id can never be interpolated into the wrong segment, and
 * so renaming a route handler is a single edit here rather than a grep.
 *
 * Server-side route handlers do NOT read from this file — their paths are their
 * own directory structure under src/app/api. This is the caller's half of that
 * contract, so a change to one still needs the other checked.
 */
export const apiRoutes = {
  projects: "/api/projects",
  project: (projectId: string) => `/api/projects/${projectId}`,

  models: "/api/models",
  credits: "/api/credits",
  billingCheckout: "/api/billing/checkout",

  githubConnect: "/api/github/connect",
  githubReauthorize: "/api/github/reauthorize",

  jobStream: (jobId: string, after: number) => `/api/jobs/${jobId}/stream?after=${after}`,
  jobMessages: (jobId: string) => `/api/jobs/${jobId}/messages`,
  jobPlan: (jobId: string) => `/api/jobs/${jobId}/plan`,
  jobStop: (jobId: string) => `/api/jobs/${jobId}/stop`,

  sessionEvents: (sessionId: string) => `/api/sessions/${sessionId}/events`,
  sessionFiles: (sessionId: string) => `/api/sessions/${sessionId}/files`,
  sessionMessages: (sessionId: string) => `/api/sessions/${sessionId}/messages`,
  sessionFork: (sessionId: string) => `/api/sessions/${sessionId}/fork`,
  sessionRestore: (sessionId: string) => `/api/sessions/${sessionId}/restore`,
  sessionStopPreview: (sessionId: string) => `/api/sessions/${sessionId}/stop-preview`,
  sessionPreviewHealth: (sessionId: string) => `/api/sessions/${sessionId}/preview-health`,
  sessionDeployments: (sessionId: string) => `/api/sessions/${sessionId}/deployments`,
  sessionDeployVercel: (sessionId: string) => `/api/sessions/${sessionId}/deploy-vercel`,
  sessionSaveGithub: (sessionId: string) => `/api/sessions/${sessionId}/save-github`,
} as const;
