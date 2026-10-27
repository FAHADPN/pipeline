// Creation constants other modules need without importing the nightly pipeline.

// A night can run several pieces of up to 60 + 20 minutes, twice each: well past the
// lock's 2-hour default before another run may take it over.
export const CREATION_STALE_MS = 24 * 3600000;

// How long after it starts a build can still be checking its session: two rounds of a
// 60-minute session (session.mjs) with a 20-minute review (review.mjs) between them.
// The second round's review doesn't verify anything. See campaigns/install-tasks.mjs.
export const BUILD_VERIFY_MINUTES = 2 * 60 + 20;

// How long a build started by hand can take to reach its first session: node and the
// campaign load. Builds keep this much more clear of a post.
export const BUILD_STARTUP_MINUTES = 20;

// Where, relative to a campaign's root, a build session writes its report
// (<id>.json) and the reviewer's files go (<id>.checks.json, <id>.review.json).
export const OUT_DIR = "creation-out";
