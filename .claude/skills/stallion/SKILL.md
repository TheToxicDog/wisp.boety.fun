---
name: stallion
description: Manage a BuyVM / FranTech Stallion VPS through the Stallion client API (SolusVM-compatible v1). Use when the user asks to boot, reboot/restart, shut down, check the status or info of, or set reverse DNS on their Stallion VPS, or asks about the Stallion API.
---

# Stallion client API

Stallion (BuyVM / FranTech) exposes a SolusVM-compatible client API. One key/hash pair belongs to one VPS, so no VPS ID is needed.

## Credentials

- Read from the environment: `API_KEY` (the key) and `API_HASH` (the hash).
- Never print, log, or commit them. Redact them from any output you show.
- Never write them into files in the repo.
- If either variable is missing, say so and ask the user to set it. Do not guess values.

## Endpoint

- `https://manage.buyvm.net/api/client/command.php`
- Accepts GET or POST. Use POST with `--data-urlencode` so values are encoded safely.
- Returns XML. Keep TLS verification on.

## Actions

| `action` | Purpose | Extra params | Success response |
| --- | --- | --- | --- |
| `boot` | Power on | none | `<statusmsg>booted</statusmsg>` |
| `reboot` | Restart | none | `<statusmsg>rebooted</statusmsg>` |
| `shutdown` | Power off | none | `<statusmsg>shutdown</statusmsg>` |
| `info` | Server info | none (optional: `bw`, `ipaddr`, `location`, `status`) | Tags such as `<bw>total,used,free,percentage</bw>` and `<ipaddr>...</ipaddr>` |
| `rdns` | Set reverse DNS on one IP | `ip` (required), `rdns` (required) | `<status>success</status>` or `error` with `<statusmsg>` |

Notes:
- There is no `restart` action. Use `reboot`.
- `hdd` and `mem` apply to OpenVZ only.
- `rdns` requests need the `Expect:` header due to a lighttpd bug on the server. The wrapper script adds it.

## Wrapper script

Use `.claude/skills/stallion/scripts/stallion.sh` rather than hand-building curl calls:

```bash
.claude/skills/stallion/scripts/stallion.sh info
.claude/skills/stallion/scripts/stallion.sh reboot
.claude/skills/stallion/scripts/stallion.sh rdns ip=199.195.250.45 rdns=host.example.com
```

The script checks the action name, sends the request, redacts the credentials from output, and exits non-zero if the response contains `<status>error</status>` or `<status>failed</status>`.

## Workflow

1. Confirm what the user wants and which action matches. Restart and shutdown interrupt a running server, so confirm before running them unless the user has already asked for that exact action.
2. Run the wrapper script with the action.
3. Report the `<status>` and `<statusmsg>` values verbatim. On error, report the message and stop. Do not retry a failed power action without asking.
4. For `info`, summarize the fields the user asked about.
