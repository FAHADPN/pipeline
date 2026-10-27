// Shared test fixtures. Not a test file itself: the suites import it.

// The posting settings a campaign gets by default, in the shape publishConfig
// (lib/campaign-deps.mjs) returns them: what runDay, planDay and the console take.
export const CONFIG = {
  timeZone: "Asia/Kolkata",
  slot: "19:30",
  lateLimitMinutes: 120,
  bufferMin: 7,
  fallbackDays: ["Mon", "Wed", "Fri", "Sun"],
  retryDelaySeconds: 60,
  platforms: {
    instagram: {
      enabled: true,
      graphVersion: "v24.0",
      useCover: true,
      thumbOffsetMs: 1500,
      tokenRefreshDays: 30,
      ngrokBin: "ngrok",
    },
    youtube: { enabled: false, privacy: "private", categoryId: "22" },
  },
};
