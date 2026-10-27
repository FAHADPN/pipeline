// Where an approved piece goes in a campaign's schedule.json, and how the file is
// written: one item per line, keys in the order given.

const LABEL_KEYS = ["title", "type"];
const WINDOW_KEYS = ["on", "notBefore", "notAfter"];

// Item = { id, kind, dir, targetDate, title?, type?, on?, notBefore?, notAfter? }
// dir is the piece's folder, relative to the campaign's root.
export function scheduleItem(entry, dir) {
  const item = { id: entry.id, kind: entry.kind, dir, targetDate: entry.targetDate };
  for (const key of LABEL_KEYS) if (entry[key] !== undefined) item[key] = entry[key];
  for (const key of WINDOW_KEYS) if (entry[key] !== undefined) item[key] = entry[key];
  return item;
}

// Before the first item planned for a later day, or at the end. Items with no
// targetDate (added by hand) keep their place. Returns a new array.
export function insertIntoSchedule(schedule, item) {
  if (schedule.some((i) => i.id === item.id)) return schedule;
  const at = schedule.findIndex((i) => i.targetDate !== undefined && i.targetDate > item.targetDate);
  return at === -1 ? [...schedule, item] : [...schedule.slice(0, at), item, ...schedule.slice(at)];
}

export function formatSchedule(items) {
  const line = (item) => `{ ${Object.entries(item).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
  return items.length ? `[\n  ${items.map(line).join(",\n  ")}\n]\n` : "[]\n";
}
