# Contributing

Contributions are welcome — bug reports, fixes, tests and documentation alike. Please open an issue first for anything larger than a small fix, so the design can be agreed on before code is written.

## Development setup

```bat
git clone https://github.com/zzaccount/dsh-remoteSSH.git
cd dsh-remoteSSH
npm install
npm run check
```

`pnpm install --ignore-scripts` works as well; the optional native SSH addons are not used by the release bundle. Node.js 24 or newer is required.

`npm run check` is the single gate for this repository and must pass before a pull request is opened:

1. `scripts/build-host.mjs` rebuilds `dist/index.js` with esbuild,
2. `scripts/check-undefined.mjs` verifies that every name called in `src/` is bound in its own module,
3. `node --check` syntax-checks every source file plus `dist/index.js` and `client.js`,
4. `node --test` runs the suite in `test/`.

## Repository rules

1. Fork the repository and create a focused branch.
2. Keep the model-facing DSH tools unchanged. Changes belong behind the official DSH Provider / extension seams — this plugin replaces execution, it does not add reduced `ssh_*` tools.
3. Commit the regenerated `dist/index.js` whenever Host source or bundled dependencies change. It is a committed artifact, not a build output that CI regenerates for release.
4. Do not commit passwords, private keys, API keys, host-specific secrets, real server addresses or local state files. Documentation and screenshots must use documentation addresses such as `203.0.113.10` and `server.example.com`.
5. Add a `CHANGELOG.md` entry for any behaviour change, and update the READMEs when the user-visible surface changes.
6. Describe behaviour changes and compatibility considerations in the pull request.

## Tests

`test/` runs on plain `node --test` and imports nothing outside `node:*` and the plugin's own pure modules — `test/workspace-files-bridge.test.mjs` and friends must keep running against a checkout that has no DSH installed. The `@deepseek-ai/*` peer dependencies are only resolvable inside DSH, so modules that import them (`src/index.js`, `src/remote-fs.js`, `src/remote-realm.js`, `src/remote-subprocess.js`) cannot be imported by a test at all; they are covered by `scripts/check-undefined.mjs` and by end-to-end checks against a real DSH installation instead. If you add such a module, keep it syntax-checked by the `check` script and free of unbound references.

A change that fixes a bug should come with a regression test at a seam that can actually reach the bug. If no such seam exists, say so in the pull request and describe the manual end-to-end check you ran (DSH version, plugin version, local or remote workspace, what you expected and what you saw).

## Reporting security issues

Follow [SECURITY.md](./SECURITY.md) instead of opening a public issue first.
