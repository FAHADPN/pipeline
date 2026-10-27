# Contributing

Thanks for helping. Pipeline is small on purpose, so a few ground rules keep it that way.

## Principles

- **No dependencies.** Plain Node.js ES modules and `node:test`. If something needs a library, open an issue first.
- **Testable core.** Logic takes its dependencies as arguments (`deps`, `make`, `exec`, `spawn`), so tests run with fakes. No test touches the network, Telegram, Claude or Task Scheduler.
- **Safety first.** Changes to the verifier, the session allowlists, secrets handling, locks or the console's action checks need a test that shows the protection still holds.
- **Comments explain why.** Match the existing style: a header comment on each module saying what it does and what it promises, and short comments where the reason isn't obvious.

## Workflow

1. Fork and branch from `main`.
2. Make the change, with tests.
3. Run the whole suite: `npm test` (or one folder: `node --test "creation/test/*.test.mjs"`, quotes included).
4. Update the docs in `docs/` if behaviour, commands or settings change.
5. Open a pull request saying what changed and why.

## License of contributions

Pipeline is licensed under the GNU AGPL v3 (`AGPL-3.0-only`). By opening a pull request, you agree that your contribution is licensed under the same terms.

## Reporting bugs

Open an issue with the command you ran, what you expected, what happened, the relevant log lines from `%USERPROFILE%\.pipeline\...\logs\` (check them for secrets first), and your Windows, Node and Claude Code versions.

For security problems, see [SECURITY.md](SECURITY.md).
