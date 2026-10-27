# Security policy

Pipeline runs unattended AI sessions with access to your social accounts, so security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Use GitHub's private vulnerability reporting instead: on this repository, go to **Security → Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You'll get an acknowledgement within a week. Please give us a reasonable time to fix the problem before you disclose it.

## Scope

In scope:

- a build session changing files outside its piece folder without the verifier catching it,
- a way to make Pipeline post without an approval,
- secrets leaking into logs, the console, Telegram messages or error text,
- console actions taken by someone other than `DASHBOARD_LOGIN`,
- anything the ngrok tunnel serves besides the item being posted.

Out of scope: anything that needs an attacker who already runs code as your Windows user, or a skill you chose to install. [docs/security.md](docs/security.md) explains this trust model.
