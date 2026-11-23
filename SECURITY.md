# Security policy

## Supported versions

Only the latest published version receives fixes. The repository is private; the
package is published to ClawHub.

## Reporting

Report suspected vulnerabilities privately to the repository owner instead of
opening a public issue: use GitHub's private vulnerability reporting on
https://github.com/zrzavywa/openclaw-project-context (Security → Report a vulnerability).

Please include the plugin version, the OpenClaw Gateway version, the agent id and a
minimal reproduction. Do not include project contents, transcripts or credentials.

## Scope

The plugin reads and writes project files inside the agent workspace
(`~/.openclaw/...`), keeps per-agent configuration in the Gateway state, and injects
project references into the prompt. Project text is treated as untrusted data. Path,
symlink, owner and size checks guard every write; the release manifest pins the
published file hashes.

## What this policy does not cover

The host (OpenClaw itself), other plugins and third-party services are out of scope.
