# Pull request

## What changed

<!-- One short paragraph, and the issue this closes if there is one. -->

## Why

<!-- The problem this solves and why this approach is the right seam. -->

## How it was tested

<!-- `npm run check` is the single verification command: it builds dist/index.js,
     runs the undefined-reference check, `node --check`s every shipped file, and
     runs the test suite. Paste what it printed, then describe any manual run
     against a real SSH server (DSH version, host OS, remote OS). -->

## Docs and CHANGELOG

- [ ] `README.md` / `README.zh-CN.md` / `ARCHITECTURE.md` updated if behavior changed
- [ ] `CHANGELOG.md` updated

## Checklist

- [ ] `npm run check` passes
- [ ] No new runtime dependency, or this pull request justifies why one is unavoidable
- [ ] No secrets, credentials, private keys or private hostnames committed
