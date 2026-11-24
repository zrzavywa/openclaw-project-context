# Contributing

## Where changes are made

This repository is the **release mirror**. Development happens in a private repository and
is exported here as exactly one commit per release, so the public history stays readable
and free of internal context. Pull requests opened here cannot be merged.

## Reporting a problem

Issues are welcome. A useful report contains:

- the OpenClaw version (`openclaw --version`) and the plugin version (the first line of `/project help`),
- the exact command or tool call, together with what you expected and what happened,
- `/project doctor` or `/project doctor json` output,
- whether the project is selected in this conversation (`/project status` names the reason if not).

Do not include credentials, real project content, or chat transcripts. Redact project names
if they are sensitive; synthetic examples reproduce almost every problem.

## Running the checks

```bash
npm test                    # behaviour suite
npm run check:changelog     # every version needs a CHANGELOG section
npm run release:verify      # manifest and file digests
```

`npm run test:gateway` is a harness smoke test that starts a Gateway; it needs roughly 1.1 GB of
memory and does not run in small sandboxes.

## Scope

The plugin never reads chat exports, other conversations, or unrelated workspace files, and it
makes no network calls. Changes that would break either property are out of scope. Project
context is stored as plain Markdown so it stays reviewable.

## Security reports

See [SECURITY.md](SECURITY.md).
