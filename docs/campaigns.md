# Campaigns

A campaign is one brand or account. It has its own folder, git repository, brief, voice, ideas, schedule, Instagram account, Telegram approvers, skills and settings. One Pipeline install runs any number of campaigns side by side, and one failing never stops the others.

## The folder

Each campaign is a folder under the campaigns root (`C:\Campaigns\<id>\`) whose name is its `id`. It must be a **git repository**: the build verifier uses git to see exactly what a build changed.

```text
C:\Campaigns\acme\
  campaign.json      settings (see campaigns/schema.md)
  brief.md           who you are, who it's for, what to make, what never to make, how to build
  voice.md           how you sound: tone, words to use and avoid, narration voice
  references.md      technique notes every build reads
  backlog.json       ideas to build
  schedule.json      approved pieces, in posting order
  guardrails.json    word lists the checks scan the caption for
  pieces\<id>\       one folder per piece: sources committed, out\ ignored
  creation-out\      build reports, check results and review verdicts
  .claude\skills\    skills only this campaign's sessions see
  .gitignore         out/
```

Create one from the [example](../examples/acme/), or with **Campaigns → New campaign** in the console, which also runs `git init` for you. New campaigns start **paused**.

## The brief, voice and references

The build session gets the **whole** of these three files in its prompt, every time. Write them for a capable stranger who has never seen your brand:

- **brief.md:** what the brand is, the audience, what kinds of pieces to make, a hard "Never" list, and **how to build**: the render stack, voice, music and cover. That last part is what makes the video. See [Video and TTS](video-and-tts.md).
- **voice.md:** tone, words to use and avoid, and the narration voice and style.
- **references.md:** craft rules that apply to every piece: hook timing, pacing, safe zones, the end card.

The reviewer judges each piece against `brief.md` and `voice.md`.

To share one voice file between campaigns, or to keep it outside the repo, point `paths.voice` at it. A path starting with `%USERPROFILE%` or `~` means your home folder.

## backlog.json: ideas

An array in target-date order. Each entry:

```json
{
  "id": "reel-01-first-sip",
  "kind": "ep",
  "format": "episode",
  "type": "story",
  "title": "The first sip",
  "premise": "What happens, in a sentence or three: the setup, the turn, the payoff.",
  "targetDate": "2026-11-02",
  "hook": null,
  "reference": "none"
}
```

| Field | Rule |
| --- | --- |
| `id` | lowercase letters, digits and dashes, unique. It becomes `pieces/<id>/`. |
| `kind` | `ep` (series episode), `post` or `special` |
| `format` | `episode`, `this-or-that`, `how-many`, `two-phones`, `greeting`, `carousel` or `hot-take`. The nightly run only picks formats listed in the campaign's `formats`. |
| `type` | the content mix: `story`, `participation`, `teach`, `opinion`, `offer` or `greeting` |
| `title`, `premise` | required text. The premise is what the build follows. |
| `targetDate` | `YYYY-MM-DD`, never earlier than the entry before it |
| `hook` | a formula number from `ig-reel`'s `hooks.json`, or `null` |
| `reference` | required text: an earlier piece to build from, or `none` |
| `on` | optional: pin the post to this date (festivals, launches) |
| `notBefore`, `notAfter` | optional: a window the post must fall in. Can't be combined with `on`. |

Add ideas in the console's **Pipeline** screen, or edit the file and commit.

## schedule.json: the queue

Approving a piece inserts it here, so you rarely edit this file by hand:

```json
[
  { "id": "reel-01-first-sip", "kind": "ep", "dir": "pieces/reel-01-first-sip", "title": "The first sip", "type": "story" }
]
```

`dir` must exist and meet the [folder contract](video-and-tts.md#the-folder-contract). Optional `on`, `notBefore` and `notAfter` work as in the backlog. Order is posting order for floating items. Reorder and pin from the console's **Pipeline** and **Calendar** screens.

## guardrails.json

An object of word lists. The checks fail a piece whose caption (or [`cues.js`](video-and-tts.md#optional-on-screen-lines), if it has one) contains any word or phrase from any list, matched as whole words, ignoring case and extra spaces:

```json
{
  "claims": ["cure", "detox", "guaranteed"],
  "selling": ["discount", "limited time"]
}
```

Use it for the hard "never say" list: legal and medical claims, competitor names, words your brand avoids.

## Several campaigns

- **Posting:** each campaign posts at its own `slot` in its own `timezone`.
- **Building:** at most `PIPELINE_MAX_BUILDS_TOTAL` builds a night across all campaigns (default 3), shared round-robin, starting from a different campaign each night.
- **Approval:** each campaign has its own approvers, and its own bot if you give it one.
- **Credentials:** each campaign has its own Instagram account, YouTube channel and optional Anthropic key.
- **Isolation:** a build's verifier fingerprints **every** campaign's secrets file, so a build in one campaign can't change another's credentials.
- **Pausing:** a paused campaign never posts or builds, but its Telegram taps are still handled.
