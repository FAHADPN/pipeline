// The console's calls to its server. Reads throw an Error carrying the HTTP status;
// actions never throw and always resolve to the server's { ok, ... } result.

import { addQuery } from "./lib/format.js";

// `path` for `campaign`. No campaign (the list hasn't loaded) asks for the server's
// default, the first campaign in folder order.
export function forCampaign(path, campaign) {
  return campaign ? addQuery(path, { campaign }) : path;
}

async function getJson(path) {
  const res = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: reported by status below.
  }
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function getCampaigns() {
  return (await getJson("/api/campaigns")).campaigns ?? [];
}

export const getStatus = (campaign) => getJson(forCampaign("/api/status", campaign));
// The machine's health is not per campaign.
export const getHealth = () => getJson("/api/health");
export const getLibrary = (campaign) => getJson(forCampaign("/api/library", campaign));
export const getPipeline = (campaign) => getJson(forCampaign("/api/pipeline", campaign));
export const getReviews = async (campaign) => (await getJson(forCampaign("/api/review", campaign))).pieces ?? [];
export const getReview = (campaign, id) => getJson(forCampaign(addQuery("/api/review", { id }), campaign));
export const getBuild = (campaign, id) => getJson(forCampaign(addQuery("/api/build", { id }), campaign));
// `from` null asks for the server's default: the weeks from the Monday of this week.
export const getCalendar = (campaign, from) => getJson(forCampaign(from ? addQuery("/api/calendar", { from }) : "/api/calendar", campaign));

// Sends one action for `campaign` with this server start's CSRF token. The server runs
// it under the campaign's publish lock, so this can wait out a scheduled run.
export async function postAction(body, { campaign, csrf }) {
  try {
    const res = await fetch("/api/action", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, campaign, csrf }),
    });
    let out;
    try {
      out = await res.json();
    } catch {
      out = { ok: false, error: `HTTP ${res.status}` };
    }
    if (res.status === 403) out = { ok: false, error: "Not allowed. Open the console through Tailscale and reload." };
    return out;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
