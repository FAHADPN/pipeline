// Whether a build is running. A build session fingerprints the publisher home's
// state.json, tokens.json and .env, its campaign's state.json and tokens.json, and every
// secrets/*.json (creation/lib/campaign-deps.mjs homeFiles), and fails if any changed.
// So the console writes no secret while any campaign builds, and no campaign state while
// that campaign builds.
//
// A build holds its campaign's "creation" lock. One older than the staleMs the nightly
// run takes it with, or whose process has died, counts as not running.
//
//   creationRunning({ lockHome, campaign, now? }) -> whether that campaign is building
//   runningBuild({ lockHome, campaigns, now? })    -> the first campaign building, or null
//   buildRunningError(...)                          -> its refusal text, or null
// campaigns = [{ name, lockName(name) }]

import { creationRunning } from "../../creation/lib/build-queue.mjs";

// The build queue starts queued builds by the same rule.
export { creationRunning };

export function runningBuild({ lockHome, campaigns, now = Date.now, alive }) {
  return campaigns.find((campaign) => creationRunning({ lockHome, campaign, now, alive })) ?? null;
}

export function buildRunningError(options) {
  const campaign = runningBuild(options);
  return campaign ? `a build is running for ${campaign.name}; try again when it finishes` : null;
}
