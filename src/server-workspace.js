import { mkdir } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'

// One SSH server is presented to DSH as one real Workspace.
//
// DSH identifies a Workspace by an existing local directory and groups Sessions
// into it when the Session header's canonical cwd equals that directory
// (`@deepseek-ai/dsh-workspace`: `WorkspaceEntity.sessionIds` filters by
// `host.sessionPath(id) === record.path`). A remote Linux path can never satisfy
// that on a Windows host, so the *grouping identity* is a local staging
// directory while the *meaning* — the machine the conversations actually run on
// — stays the SSH server, injected through this plugin's execution world.
//
// The staging directory is deliberately empty: the real files live on the remote
// machine. Its display title is kept equal to the server name, so the left
// workspace column reads "srv (ubuntu)" and every conversation created inside it
// is nested under that server as one group.

const STAGING_DIR = 'remote-ssh-workspaces'

/** Local staging directory that carries one server's Workspace identity. */
export function serverWorkspaceDir(baseDir, serverId) {
  return join(String(baseDir || '.'), STAGING_DIR, String(serverId))
}

/** The Workspace display title for one server. */
export function serverWorkspaceTitle(server) {
  return String(server?.name || server?.id || '服务器')
}

/** `serverId -> staging directory` for the whole registry, for Host views. */
export function workspaceDirs(baseDir, servers) {
  const map = {}
  for (const server of servers || []) {
    if (!server?.id) continue
    map[server.id] = serverWorkspaceDir(baseDir, server.id)
  }
  return map
}

// ---------------------------------------------------------------------------
// Sub-workspaces: one remote directory inside a server
// ---------------------------------------------------------------------------
//
// DSH nests Workspaces in the left column purely by directory containment
// (`owningParentFolder` keeps the nearest registered ancestor path), so a remote
// directory becomes a *child* row of its server the moment its staging directory
// is staged *inside* the server's staging directory. That containment is the
// whole sub-workspace mechanism — no custom tree UI is involved.
//
// A remote path cannot be spelled as a Windows directory name as-is (separators,
// `:` and reserved characters), so every child gets a stable slug
// `<segment>-<pathhash>`: the leading segment keeps the directory readable in a
// path tooltip, the hash keeps two same-named directories apart and makes
// re-picking the same remote path resolve to the SAME staging directory.

const SEGMENT_LIMIT = 40
const ILLEGAL_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/g

/** Stable 8-hex-digit FNV-1a of a remote path; the slug's uniqueness carrier. */
export function remotePathKey(remotePath) {
  const text = String(remotePath || '')
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Directory segment for one remote path, safe on every host filesystem. */
export function folderWorkspaceSlug(remotePath) {
  // Both halves of the slug come from the canonical spelling, so `…/app` and
  // `…/app/` (or `…/a/../app`) are the SAME staging directory instead of two
  // Workspaces for one remote directory. `posix.normalize` keeps a trailing
  // separator, so it is stripped here rather than trusted.
  const normalized = posix.normalize(String(remotePath || ''))
  const canonical = normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized
  const raw = posix.basename(canonical) || 'dir'
  const safe = raw
    .replace(ILLEGAL_SEGMENT, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
  const segment = (safe || 'dir').slice(0, SEGMENT_LIMIT)
  return `${segment}-${remotePathKey(canonical)}`
}

/** Local staging directory that carries one remote directory's Workspace identity. */
export function folderWorkspaceDir(baseDir, serverId, remotePath) {
  return join(serverWorkspaceDir(baseDir, serverId), folderWorkspaceSlug(remotePath))
}

/** The directory's own name — the title the user asked for. */
export function folderWorkspaceTitle(remotePath) {
  const normalized = posix.normalize(String(remotePath || ''))
  return posix.basename(normalized) || normalized || String(remotePath || '')
}

/**
 * Directory name, qualified by its parent only when a sibling workspace already
 * answers to the plain name, so two `/…/app` directories never render as two
 * identical rows.
 */
export function uniqueFolderWorkspaceTitle(remotePath, taken) {
  const used = taken instanceof Set ? taken : new Set(taken || [])
  const name = folderWorkspaceTitle(remotePath)
  if (!used.has(name)) return name
  const parent = posix.basename(posix.dirname(posix.normalize(String(remotePath || ''))))
  const qualified = parent ? `${parent}/${name}` : name
  if (!used.has(qualified)) return qualified
  let suffix = 2
  while (used.has(`${qualified} (${suffix})`)) suffix += 1
  return `${qualified} (${suffix})`
}

// DSH records a Workspace by the canonical realpath of its directory (long
// paths, resolved separators, and case on Windows), so compare in the same
// normalized shape instead of trusting the spelling we registered.
function comparable(path) {
  let value = String(path || '').trim()
  if (!value) return ''
  value = value.replace(/^\\\\\?\\/, '')
  try {
    value = resolve(value)
  } catch {
    // A non-resolvable spelling stays as-is; the comparison then simply misses.
  }
  value = value.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

// Resolved lazily and defensively from whichever context the caller hands in: a
// profile without the workspace service still runs remote execution, so this
// module never requires the service. `src/index.js` reaches the real registry by
// running these helpers inside `ctx.inject(['workspaceRegistry'], …)`, which is
// also what makes the registration wait for a late-mounted registry instead of
// racing it.
function registryOf(ctx) {
  if (!ctx) return undefined
  try {
    const direct = ctx.workspaceRegistry
    if (direct && typeof direct.create === 'function') return direct
  } catch {
    // Fall through to the injection-free lookup below.
  }
  try {
    const looked = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    return looked && typeof looked.create === 'function' ? looked : undefined
  } catch {
    return undefined
  }
}

/**
 * Register `dir` as a Workspace titled `title`, reusing the record that already
 * owns that directory and retitling it when the title moved on (a renamed
 * server, a re-picked directory whose parent taken the plain name).
 *
 * Returns the Workspace, or `undefined` when this deployment mounts no workspace
 * registry (the plugin then simply runs without workspace grouping).
 */
export async function ensureRegisteredWorkspace(ctx, dir, title, logger) {
  const registry = registryOf(ctx)
  if (!registry) return undefined
  await mkdir(dir, { recursive: true })
  let workspace
  try {
    workspace = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(dir) : undefined
  } catch (error) {
    logger?.warn?.(`DSH Remote SSH workspace lookup ${dir}: ${String(error)}`)
  }
  if (!workspace) workspace = await registry.create(dir, title)
  if (workspace && title && workspace.title !== title && typeof workspace.setTitle === 'function') {
    try {
      await workspace.setTitle(title)
    } catch (error) {
      logger?.warn?.(`DSH Remote SSH workspace title ${dir}: ${String(error)}`)
    }
  }
  return workspace
}

/**
 * Bring one server's Workspace registration in line with its connection record:
 * create the staging directory, register or reuse the Workspace, and keep its
 * display title equal to the server name.
 */
export async function syncServerWorkspace(ctx, baseDir, server, logger) {
  if (!server?.id) return undefined
  return await ensureRegisteredWorkspace(ctx, serverWorkspaceDir(baseDir, server.id), serverWorkspaceTitle(server), logger)
}

/**
 * One remote directory inside one server, as a child Workspace of that server.
 * `options.title` overrides the directory's own name (used when a sibling already
 * answers to the plain name); `options.logger` only receives warnings.
 */
export async function syncFolderWorkspace(ctx, baseDir, server, remotePath, options = {}) {
  if (!server?.id || !remotePath) return undefined
  const dir = folderWorkspaceDir(baseDir, server.id, remotePath)
  return await ensureRegisteredWorkspace(ctx, dir, options.title || folderWorkspaceTitle(remotePath), options.logger)
}

/** Sync every server, isolating per-server failures. */
export async function syncServerWorkspaces(ctx, baseDir, servers, logger) {
  const created = []
  for (const server of servers || []) {
    try {
      const workspace = await syncServerWorkspace(ctx, baseDir, server, logger)
      if (workspace) created.push({ serverId: server.id, workspaceId: workspace.id })
    } catch (error) {
      logger?.warn?.(`DSH Remote SSH server workspace ${server?.id}: ${String(error)}`)
    }
  }
  return created
}

/**
 * Sync every remembered remote directory. `folders` is the durable list from the
 * store (`{ serverId, remotePath, title }`); a record whose server is gone is
 * skipped instead of resurrected.
 */
export async function syncFolderWorkspaces(ctx, baseDir, servers, folders, logger) {
  const byId = new Map((servers || []).filter(server => server?.id).map(server => [server.id, server]))
  const created = []
  for (const folder of folders || []) {
    const server = byId.get(String(folder?.serverId || ''))
    if (!server || !folder?.remotePath) continue
    try {
      const workspace = await syncFolderWorkspace(ctx, baseDir, server, folder.remotePath, { logger, title: folder.title })
      if (workspace) created.push({ serverId: server.id, remotePath: folder.remotePath, title: workspace.title, workspaceId: workspace.id })
    } catch (error) {
      logger?.warn?.(`DSH Remote SSH folder workspace ${server.id}:${folder.remotePath}: ${String(error)}`)
    }
  }
  return created
}

/**
 * The inverse of the sync helpers above, for the moment this plugin goes away:
 * delete the Workspace registrations created for `servers` and `folders`, so
 * disabling the plugin also takes its server workspaces out of the sidebar.
 *
 * Only the registrations are removed. The staging directories stay on disk — the
 * same durable server list recreates them on the next activation, and a directory
 * on disk is not a sidebar row by itself. A record whose Workspace already went
 * missing is skipped instead of treated as an error, and one failure never stops
 * the rest of the cleanup.
 */
export async function releaseWorkspaceRegistrations(ctx, baseDir, servers, folders, logger) {
  const registry = registryOf(ctx)
  if (!registry || typeof registry.delete !== 'function') return []
  const targets = [
    ...(servers || []).filter(server => server?.id).map(server => ({
      label: `server ${server.id}`,
      dir: serverWorkspaceDir(baseDir, server.id),
      id: undefined,
    })),
    ...(folders || []).filter(folder => folder?.serverId && folder?.remotePath).map(folder => ({
      label: `folder ${folder.serverId}:${folder.remotePath}`,
      dir: folderWorkspaceDir(baseDir, folder.serverId, folder.remotePath),
      id: folder.workspaceId ? String(folder.workspaceId) : undefined,
    })),
  ]
  const removed = []
  for (const target of targets) {
    // A remembered Workspace id is tried first because the durable record is the
    // authority on which row this plugin created; a stale id falls back to the path.
    if (target.id) {
      try {
        await registry.delete(target.id)
        removed.push(target.id)
        continue
      } catch {
        // Fall through to the path lookup below.
      }
    }
    try {
      if (typeof registry.resolveByPath !== 'function') continue
      const workspace = await registry.resolveByPath(target.dir)
      if (!workspace?.id) continue
      await registry.delete(workspace.id)
      removed.push(workspace.id)
    } catch (error) {
      logger?.warn?.(`DSH Remote SSH workspace release ${target.label}: ${String(error)}`)
    }
  }
  return removed
}

/**
 * Map a Session's canonical cwd back to the server whose Workspace owns it. This
 * is how a conversation started inside the "srv (ubuntu)" workspace runs on that
 * server without the user picking an execution location first.
 */
export function serverForSessionCwd(baseDir, servers, cwd) {
  const wanted = comparable(cwd)
  if (!wanted) return undefined
  for (const server of servers || []) {
    if (!server?.id) continue
    if (comparable(serverWorkspaceDir(baseDir, server.id)) === wanted) return server
  }
  return undefined
}

/**
 * Full execution location of a Session, from its canonical cwd:
 * `{ server, remotePath }` for a remote directory child workspace,
 * `{ server }` for the server's own workspace, or `undefined` for anything local.
 *
 * `folders` is the durable remote-directory list; a Session opened inside a child
 * workspace therefore keeps running where that directory actually lives, instead
 * of silently falling back to the server's default root.
 */
export function locationForSessionCwd(baseDir, servers, folders, cwd) {
  const wanted = comparable(cwd)
  if (!wanted) return undefined
  for (const folder of folders || []) {
    const server = (servers || []).find(item => item?.id === folder?.serverId)
    if (!server || !folder.remotePath) continue
    if (comparable(folderWorkspaceDir(baseDir, server.id, folder.remotePath)) === wanted) {
      return { server, remotePath: String(folder.remotePath) }
    }
  }
  const server = serverForSessionCwd(baseDir, servers, cwd)
  return server ? { server } : undefined
}
