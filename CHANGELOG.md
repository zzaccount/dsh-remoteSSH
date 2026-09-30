# Changelog

## 1.0.10 - 2026-09-30

- Make the conversation row's `🌐` execution-location menu a chooser again. It carried a three-line paragraph under 「服务器工作区」 (「每台服务器都是左侧工作区里的一个独立分组，组内新建的对话直接在这台服务器上执行」) and gave every row a second line (`user@host:22 · 按需连接`), which wrapped inside the narrow column: a two-Server menu came out taller than the Workspace list it hangs off. The paragraph is gone; a row's subtitle is the address alone (`user@host`, with the port only when it is not 22); the connection state moved into the row tooltip, beside the state dot the row already carried; 「本地电脑」 and 「管理服务器」 are single-line rows; and 「添加服务器」 says 「保存后成为左侧工作区」. Sizes now follow the host menu's own grid (13 px rows, 20 px line-height, 11 px captions, 4 px card padding, 236 px card) instead of inheriting the app's body text, and doubled class selectors hold them inside the host's portaled card, whose descendant typography outranks a bare class of ours.
- Keep the Server spellings in one place: `serverAddress` (the port only when it is not the SSH default) and `connectionStateLabel` now back the menu tooltip and the panel and management row subtitles, so the three surfaces cannot drift apart.
- Tests: 43 pass (`npm run check`). New coverage: the menu renders no explanatory paragraph, every row subtitle is one short line (30 characters or less, no state suffix), the address keeps a non-default port and drops `:22`, and the row tooltip still reports the connection state.

## 1.0.9 - 2026-09-30

- Stop the Server editor from moving the conversation it was opened from. Saving a Server (`测试并保存`) used to append `target.set({ sessionId, target: { type: 'ssh', serverId } })` for the row's Session, and the Server editor is reachable from a conversation row (`🌐 → 添加服务器 / 管理服务器`), so *editing or re-testing an already saved Server* re-applied that Session's remote target. A conversation that lives in a local Workspace (`cwd` = a normal folder) therefore kept flipping back to the server right after the user picked 「本地电脑」 — the durable record for the user's own Session showed exactly that shape: four `local -> ssh` handoffs, two of them 2.6 s apart. Saving a Server now only tests and stores the connection; the host's `server.testAndSave` never touched a Session, so the client was the only implicit writer. Add the regression to `test/client-smoke.test.mjs`: it renders the execution-location row action with a Session id, drives `🌐 → 管理服务器 → 编辑 → 测试并保存` through a stubbed `fetch`, and asserts the whole flow settles with `server.testAndSave` called and **no** `target.set` — the test fails against 1.0.8 (it observed `target.set {sessionId:'sess_1', target:{type:'ssh', serverId:'srv_1'}}`).
- Take this plugin's Server workspaces out of the sidebar when the plugin is disabled or uninstalled. The registrations outlived the plugin, so disabling it left 「服务器工作区」 rows (`srv (ubuntu)`, `srv-root (root)`, and one row per remote folder) pointing at a remote runtime that no longer existed; re-enabling registers them again from the same durable server list, because activation already syncs every Server and remembered folder idempotently. Add `releaseWorkspaceRegistrations` to `src/server-workspace.js` — the inverse of the `sync*` helpers, deleting only the Workspaces this plugin created (a remembered folder `workspaceId` first, then a path lookup, so a stale id falls back instead of leaving a row behind, and a local Workspace is never a candidate) — and call it from the existing `ctx.effect` teardown through the workspace context captured at registration time, since disposal races the service's own teardown. Only the rows go: the local staging directories stay on disk (they hold no files; the tree's files come from the server), and Session records are untouched.
- Say what the form does. The Session-row form's first line promised 「连接成功后，当前对话的官方 DSH 工具将在该服务器执行」 and the connection guide promised 「…并保存非敏感服务器配置并切换当前对话」; both now state that saving only tests and saves the connection, and that switching a conversation is the row's own `🌐` menu. The panel route already promised exactly this, and `docs/服务器工作区-交互设计.md` now records that the promise must match on both routes.
- Tests: 42 pass (`npm run check`). New coverage: the release helper against a fake registry (deletes exactly the server row and the remembered folder row, skips a Server that was never registered, returns the removed ids, and never calls `create`) and the client flow above.

## 1.0.8 - 2026-09-29

- Make the right sidebar's file tree show the server. The "工作区文件" column — and every file it opens, including the document preview — is the official `workspace-files` Remote, which reads through the deployment-wide (local) filesystem; for a conversation executing on a server it therefore listed the conversation's local staging directory, which this plugin keeps empty on purpose. The Remote service instance is now bridged for remotely executed Sessions only: its path-taking methods run with their own official bodies, pointed at that Session's execution world (an isolated `fs` provider over the same SSH connection pool) and with every incoming path rebased from its Host spelling onto the world. A locally executed conversation keeps the untouched implementation, and a route that cannot be resolved falls back to it rather than failing a local listing.
- List directories, open files, read text and bytes, and refresh manually on the server. The file tree's Host paths — its root is the Session's `cwd`, the staging directory — are translated to the world's remote root, and the remote paths the Remote hands back pass through unchanged, so expanding a folder, opening a file, and stat-based previews round-trip.
- Report change notifications as `workspace-file/watch-unsupported` for a remote world, through the official change feed, because watching is not supported. The sidebar treats that code as "no live refresh" (manual refresh still works) and the document preview opens the file regardless, so nothing surfaces as an error.
- Report a symlinked directory as a directory. Reading a remote directory reported every child with `lstat` semantics, so a symlinked directory arrived as `symlink`; the file tree expands directories only, which made every such link a dead leaf row whose preview failed with `workspace-file/not-regular-file`. The official `list` body forwards a child's `type` verbatim and the local backend probes each child with follow semantics, so the remote backend now resolves a symlinked child before reporting it (the same thing the plugin's own remote-directory browser already did) and keeps the link's own entry type when it cannot be followed. `.` and `..` are filtered out with it, as no backend reports them.
- Mount a remote execution world at all. `mountRemoteFilesystem` reached the world-mount step through `mountService`, which is only this module's export alias and not a local binding, so creating a world threw `ReferenceError: mountService is not defined` and every directory read in the sidebar's file tree answered "读取失败：mountService is not defined". The call now uses the local `mount`, and the world it builds is verified by mounting one against a stand-in context (it registers as the isolated `fs` service and reuses a supplied environment without opening SFTP). Add `scripts/check-undefined.mjs` to `npm run check`: it reads `src` as text and reports every name that is called without being bound in its module (import, declaration, parameter, catch binding, or a known global). Exactly the modules that need the Host's module graph — this one imports official packages only DSH resolves — can never be imported by `node --test`, so no test can execute them; the scan is what catches this class there.
- Reuse a running conversation's resolved world (`cwd`/`home`, matched on the realm signature) instead of probing it again, and cache one world per server, remote directory and authentication identity; the cached worlds are disposed with the plugin, and every patched method is restored exactly as it was.
- Keep a failing route resolver from affecting local browsing: it falls back to the untouched service body and logs the reason. `changes` stays an async iterable (an async generator that routes first) instead of becoming a promise a caller cannot iterate.
- Add `test/workspace-files-bridge.test.mjs`: the Host path translation table (Windows roots, mixed separators, workspace-relative paths, paths outside the workspace, remote absolute paths, the root, empty, uncased roots), the routed filesystem, and the bridge itself against a fake service — a local Session stays untouched, a remote one reads the routed world through `this.ctx.fs` and `this.feed.ctx`, worlds are cached per directory, a failing world is reported and not cached, `changes` answers `workspace-file/watch-unsupported` without touching a local path, installing twice patches once, the instance is patched through the Cordis traceable proxy, a route resolver that throws falls back to the untouched body, and disposal restores the prototype methods.

- Keep the bridge suite runnable where Host paths and remote paths are spelled the same: "a Host path outside the workspace lands on the remote root" is only reachable while the two spellings differ, so it is asserted on Windows and its POSIX counterpart (such a path is itself a valid remote path and passes through) everywhere else.
- Add repository scaffolding: a GitHub Actions workflow that runs the same `npm run check` gate, a tag-driven release workflow that packs the plugin and attaches the tarball to a GitHub release, issue forms and a pull-request template, and `.editorconfig`.

## 1.0.7 - 2026-09-29

- Make "服务器工作区" the workspace column's main entry point of this plugin: the sidebar-foot "执行位置" popover is removed, and server management (add / edit / reconnect / delete) is owned by that panel. Adding a server used to require opening one popover and then managing it in another; the panel is one surface now. The conversation-row location menu keeps its own "添加服务器" / "管理服务器" rows, because a conversation can be pointed at a server that does not exist yet without a detour.
- Add "＋ 添加服务器" and "管理服务器" to the panel's server section header. Both open as views of the same dialog (the form, or the server list) instead of a second dialog, so a click inside them can never read as "outside the panel", and the surrounding error/notice rows stay visible.
- Keep the panel from retargeting conversations: saving a server from it only saves (no `target.set`, so no Session is needed), and its own "加为工作区" is what starts a conversation on that server. Switching the execution location of an existing conversation stays on that conversation's row action in the workspace column.
- The panel's server form saves with `sessionId: null` and reaches the server list through the shared `overview` snapshot, so a saved server appears in the panel and in the left column without a page reload.
- Keep the per-conversation affordances unchanged: the globe badge in a conversation row and its hover action still open the location menu, including adding or managing a server from there.
- Make the location picker row-shaped only: with no footer caller left, `TargetMenu` loses its footer variant (the label plus chevron rendering, its `disabled` gate, and the `showName` / `variant` props) along with the CSS that only that variant used. The rendered row action is unchanged - same props, same menu, same title.
- Extend the client-bundle smoke test with a hook runtime that keeps component state across renders, so state transitions are observable: the footer must hold exactly one plugin entry, the location entry must stay on the conversation row action, the panel's "添加服务器" and "管理服务器" must open the form and the server list respectively, and choosing a Server on a conversation row must send `target.set` with that row's own `sessionId`. All of these fail when the corresponding button or payload is made inert.
- Make the smoke test's renderer flatten mapped children the way React does; without it every `rows.map(...)` row was invisible to `findButton` / `texts`, so no test could assert a rendered list row.

## 1.0.6 - 2026-09-29

- Add remote folders as child workspaces: any directory on a server can be registered as a workspace nested under that server's workspace. Conversations created in it start in that remote directory instead of the server's default root.
- Add a dedicated sidebar-foot entry "服务器工作区" (add a server / add a folder on a server), deliberately beside the DSH "＋ 添加工作区" flow instead of inside it: the `directoryFlow` holes already hold the bundled native picker (renderless, it opens the OS dialog on the very same click) and the in-app browse picker, so a third occupant would race them.
- Add `remote.browse`, `workspace.addServer`, `workspace.addFolder` and `workspace.forgetFolder` RPCs. Remote directory browsing resolves `~`, relative and absolute paths over SFTP, returns real paths, and marks symlinked directories.
- Fix the reason no server workspace ever appeared: the plugin never obtained `workspaceRegistry`, because Cordis hides services provided by sibling fibers unless they are injected. Addressed with `ctx.inject(['workspaceRegistry'], …)` plus a `registryReady` gate (Cordis 4.0.4 has no `inject: { required, optional }` form), so registration happens whenever that service mounts, including late.
- Make the remote folder → workspace mapping deterministic (`<basename>-<hash8>` of the normalised remote path), so re-picking the same directory opens the existing workspace instead of adding a duplicate; titles fall back from the directory name to `parent/name` to `www/app (2)` only on collision.
- Feed the child workspace's remote directory into its Agent realm signature, so moving a conversation between a server workspace and one of its folders rebuilds the remote realm with the right `cwd`.
- Cascade server deletion to the workspace registrations of its remote folders (sessions and staging directories are kept), and make removing one remote directory from the dialog run the same cascade for that folder: the left workspace row disappears too, while the staging directory and its conversations stay on disk (re-picking the same directory registers it again).
- Open a freshly created workspace only once the Client's own workspace mirror has caught up (`workspaces.list.getSnapshot().items`), instead of retrying `openWorkspace` and provoking one DSH "新建会话失败" toast per attempt; a residual miss degrades to a single inline notice.
- Re-arm the shared `overview` poll whenever it is refreshed (the failure circuit breaker used to leave a recovered Host permanently unpolled) and hide a just-removed folder row until the Host push stream catches up.
- Add host tests for slug stability and Windows safety, child-workspace nesting, title disambiguation, folder sync failure isolation, and the `cwd → (server, remote directory)` resolution; add a client-bundle smoke test that evaluates the real `client.js` with React stubs, runs `apply(ctx)` against a fake slot host, resolves each entry's injected props (including a facade that throws on every lookup), renders the new dialog, and then drives its buttons through a stubbed `fetch` and a fake workspace mirror — asserting the mirror is polled before the single `openWorkspace` call. Both regression classes (dropping the mirror probe, dropping the absent-mirror refresh) make it fail.

## 1.0.5 - 2026-09-29

- Port the plugin to DSH 0.2.0-rc.1 (Cordis service and slot contracts, `connection.fetch` host seam, official Web plugin slots).
- Register every saved SSH server as a real DSH workspace backed by a local staging directory, so the native left workspace column lists one group per server and conversations created inside it run on that server.
- Adopt a server when a conversation's header `cwd` is that server's staging directory; an explicit per-conversation choice still wins.
- Move the execution-location control from the composer into the left workspace column (sidebar foot plus a globe badge and per-row switch action).
- Add host tests for the server-workspace mapping and registration.

## 1.0.3 - 2026-08-24

- Ship a prebuilt portable Host bundle containing the pure-JavaScript `ssh2` runtime.
- Remove `ssh2` and its optional `cpu-features` native addon from end-user runtime dependencies.
- GitHub/Profile installation no longer requires `allowBuilds`, `pnpm approve-builds`, native compilation, or a weaker Profile-wide `strictDepBuilds` setting.
- Keep DSH packages external so the plugin still composes with the official Host providers and tools.
- No SSH transport, authentication, remote filesystem, terminal, or UI behavior changed.

## 1.0.2

- Fix RPC response-envelope mismatch introduced during the package rename.
- `server.testAndSave` now returns the saved server correctly to the client, so "Test and Save" can immediately switch the current conversation to the new SSH execution target.
- Client accepts the legacy internal envelope marker during upgrades.

## 1.0.1 - 2026-08-24

Packaging fix for out-of-tree DSH profile installs.

- Declare the official `@deepseek-ai/dsh-bash-local` and `@deepseek-ai/dsh-tool-terminal` consumers as plugin runtime dependencies because the remote execution realm mounts them directly and they are not guaranteed to exist in every host profile fallback.
- Keep DSH capability/service packages as host-provided peers so the plugin still composes with the running Harness services.
- No SSH transport, provider, UI, authentication, or model-facing tool behavior changed from 1.0.0.

## 1.0.0 - 2026-08-24

First public release of DSH Remote SSH.

- Remote Linux execution through native DSH filesystem, subprocess, shell and terminal providers.
- Local / remote execution switching inside the same conversation.
- SSH Agent, private-key file and ephemeral password authentication.
- Host-key fingerprint verification.
- SFTP filesystem transport and SSH process / PTY transport.
- Remote ripgrep resolution and cache while preserving official DSH search behavior.
- Persistent, UI-only execution handoff markers.
- OS-specific onboarding guides for SSH authentication.
