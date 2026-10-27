// Per-campaign secrets: platform tokens, the Telegram bot token and an optional
// Anthropic key. One JSON file per campaign at <home>/secrets/<id>.json, in the
// publisher home and never inside a campaign directory, written atomically.
// Values only ever leave through get(). status() reports which names are set
// and when, and no error message includes a value or the file's contents.
// File = { version: 1, secrets: { [name]: { value, updatedAt } } }

import fs from "node:fs";
import path from "node:path";

export const SECRET_NAMES = [
  "IG_ACCESS_TOKEN",
  "IG_USER_ID",
  "IG_USERNAME",
  "IG_ISSUED_AT",
  "YT_REFRESH_TOKEN",
  "YT_CHANNEL",
  "TELEGRAM_BOT_TOKEN",
  "ANTHROPIC_API_KEY",
];

const ID_RE = /^[a-z0-9-]+$/;

function checkId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("bad campaign id");
}

function checkName(name) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`unknown secret ${JSON.stringify(String(name))} (known: ${SECRET_NAMES.join(", ")})`);
}

export function createSecrets(home, { now = () => new Date() } = {}) {
  const dir = path.join(home, "secrets");
  const fileFor = (id) => path.join(dir, `${id}.json`);

  function read(id) {
    const file = fileFor(id);
    if (!fs.existsSync(file)) return { version: 1, secrets: {} };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    } catch {
      // JSON.parse quotes the text around the fault, which could be a token.
      throw new Error(`can't read ${file}: not valid JSON`);
    }
    if (data === null || typeof data !== "object" || typeof data.secrets !== "object" || data.secrets === null) {
      throw new Error(`can't read ${file}: not a secrets file`);
    }
    return data;
  }

  function write(id, data) {
    const file = fileFor(id);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, file);
  }

  return {
    get(id, name) {
      checkId(id);
      checkName(name);
      const { secrets } = read(id);
      return Object.hasOwn(secrets, name) ? secrets[name].value : undefined;
    },
    set(id, name, value) {
      checkId(id);
      checkName(name);
      if (typeof value !== "string" || value === "") throw new Error(`${name} must be text`);
      const data = read(id);
      data.secrets[name] = { value, updatedAt: now().toISOString() };
      write(id, data);
    },
    remove(id, name) {
      checkId(id);
      checkName(name);
      const data = read(id);
      if (!Object.hasOwn(data.secrets, name)) return;
      delete data.secrets[name];
      write(id, data);
    },
    status(id) {
      checkId(id);
      const out = {};
      for (const [name, entry] of Object.entries(read(id).secrets)) {
        if (SECRET_NAMES.includes(name)) out[name] = { set: true, updatedAt: entry.updatedAt };
      }
      return out;
    },
  };
}
