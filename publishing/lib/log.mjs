// Append-only monthly log in <home>/logs/YYYY-MM.log, one line per event.
// Any key that looks like a token or secret is redacted, however deep.

import fs from "node:fs";
import path from "node:path";
import { istDate } from "./dates.mjs";

const SECRET_KEY = /token|secret/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Error) return { message: value.message };
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(v)]));
  }
  return value;
}

export function createLogger(home) {
  const dir = path.join(home, "logs");
  function write(level, msg, data) {
    const now = new Date();
    fs.mkdirSync(dir, { recursive: true });
    const tail = data === undefined ? "" : ` ${JSON.stringify(redact(data))}`;
    fs.appendFileSync(path.join(dir, `${istDate(now).slice(0, 7)}.log`), `${now.toISOString()} ${level} ${msg}${tail}\n`);
  }
  return {
    info: (msg, data) => write("INFO", msg, data),
    error: (msg, data) => write("ERROR", msg, data),
  };
}
