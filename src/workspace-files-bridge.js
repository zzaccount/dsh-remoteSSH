import { isAbsolute, posix, relative, resolve as resolveHostPath, sep } from 'node:path'

/**
 * Serve the official Workspace Files Remote from a Session's execution world.
 *
 * The right sidebar's file tree, and every file the sidebar or the document
 * preview opens from it, is the official `@deepseek-ai/dsh-api-workspace-files`
 * Remote. It resolves a `SessionId` into `{ sessionId, workspaceRoot }` and then
 * reads everything through the deployment-wide `ctx.fs`: one backend per
 * composition. For a Session whose execution world is a server that backend is
 * the wrong world, so the sidebar lists the local staging directory — which this
 * plugin keeps empty on purpose — instead of the machine the conversation
 * actually runs on.
 *
 * DSH has exactly one `ctx.fs` and no per-session backend, so the seam that
 * keeps the official contract intact is the Remote's own implementation: the
 * gateway re-reads a method from the service instance on every invocation
 * (`Reflect.get(callReceiver, method)`), and every read path funnels its paths
 * through a handful of filesystem operations.
 *
 * This bridge therefore replaces the path-taking methods on the service instance
 * with wrappers that, for a remotely executed Session only, call the official
 * body with
 *
 * - `this.ctx.fs` bound to that Session's execution world, and
 * - every incoming path translated from its Host spelling — the local staging
 *   root the Session carries as `cwd` — into the world's spelling.
 *
 * Result shapes, error codes, echoed paths and the Remote codec stay exactly as
 * shipped, and a locally executed Session keeps the untouched implementation.
 * Change notifications report the documented `workspace-file/watch-unsupported`
 * failure, because watching a remote world is not supported: the sidebar and the
 * document preview both tolerate that answer, so listing, reading and manual
 * refresh keep working and only live refresh is off.
 *
 * This module is deliberately free of Host imports: it moves paths and patches
 * one service instance, and the caller supplies the world factory.
 */

/** Cordis serves every service through a traceable proxy; this key recovers the instance. */
const ORIGINAL = Symbol.for('cordis.original')

/** Own-property marker for the installed bridge, and the handle that removes it. */
export const BRIDGE = Symbol.for('dsh-remote-ssh/workspace-files-bridge')

/** The Remote methods that turn a Host path into filesystem operations. */
const ROUTED_METHODS = ['list', 'stat', 'read', 'readBytes', 'changes']

/** Methods whose answer is an async iterable, which a promise cannot stand in for. */
const STREAM_METHODS = new Set(['changes'])

function joinRemote(remoteRoot, suffix) {
  const tail = String(suffix).replace(/\\/g, '/').replace(/^\/+/, '')
  return tail.length === 0 ? remoteRoot : posix.join(remoteRoot, tail)
}

/** Canonical remote directory: POSIX, no trailing separator except at the root. */
function normalizeRemoteRoot(remoteRoot) {
  const normalized = posix.normalize(String(remoteRoot || '/'))
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/**
 * Translate one Host Workspace path into the remote execution world's spelling.
 *
 * The sidebar addresses entries with Host paths derived from `workspaceRoot` (the
 * Session's local staging root), while a remote filesystem only knows remote
 * paths, so every path crossing the bridge is rebased:
 *
 * - the workspace root itself, and anything below it, map onto the remote root;
 * - a workspace-relative path is a path inside the world already;
 * - an absolute POSIX path that is not below the workspace root is a remote path
 *   produced by the bridge itself (the `absolutePath` of a stat), so it passes
 *   through unchanged;
 * - anything else is a Host path with no counterpart in the world — another
 *   Session's directory, a drive root — and lands on the remote root, which is
 *   the closest honest answer and matches how the execution realm treats such
 *   paths.
 *
 * @param workspaceRoot - the Session's local staging root, as the Host reports it.
 * @param remoteRoot - the world's absolute remote directory for this Session.
 * @param path - the incoming Host path; empty means the workspace root.
 * @returns an absolute remote path inside `remoteRoot`, or an already-remote absolute path.
 */
export function translateWorkspacePath(workspaceRoot, remoteRoot, path) {
  const remote = normalizeRemoteRoot(remoteRoot)
  const raw = String(path ?? '')
  if (raw.length === 0) return remote
  const root = String(workspaceRoot || '')
  if (!isAbsolute(raw)) return joinRemote(remote, raw)
  if (root.length === 0) return raw.startsWith('/') ? posix.normalize(raw) : remote
  const inside = relative(resolveHostPath(root), resolveHostPath(raw))
  if (inside.length === 0) return remote
  if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return joinRemote(remote, inside)
  if (raw.startsWith('/')) return posix.normalize(raw)
  return remote
}

/**
 * One view of a Session's execution world, addressed from the Host.
 *
 * The backend is whatever filesystem that world runs on, with the three
 * operations that decide *which* world a call touches rewritten: `resolve` and
 * `lstat` receive Host paths and must see world paths, and `watch` must fail so
 * the official change feed answers the documented
 * `workspace-file/watch-unsupported` instead of watching a local path. Every
 * other operation receives the targets those three produce, so it is delegated
 * unchanged.
 *
 * @param fileSystem - the world's filesystem instance.
 * @param workspaceRoot - the Session's local staging root.
 * @param remoteRoot - the world's absolute directory for this Session.
 * @returns a filesystem interface for the official Remote body.
 */
export function routedFileSystem(fileSystem, workspaceRoot, remoteRoot) {
  const translate = path => translateWorkspacePath(workspaceRoot, remoteRoot, path)
  const routed = Object.create(fileSystem)
  Object.defineProperties(routed, {
    resolve: {
      value: (path, opts) => fileSystem.resolve(translate(path), opts?.signal ? { signal: opts.signal } : undefined),
    },
    lstat: {
      value: (path, opts, signal) => fileSystem.lstat(translate(path), undefined, signal ?? opts?.signal),
    },
    watch: {
      value: async () => {
        throw new Error('remote execution worlds report workspace-file/watch-unsupported')
      },
    },
  })
  return routed
}

/** The `this` an official Remote body runs with: the instance, pointed at one world. */
function worldReceiver(service, fileSystem) {
  const inner = Object.create(service.ctx, {
    fs: { value: fileSystem, writable: true, configurable: true, enumerable: true },
  })
  const receiver = Object.create(service, { ctx: { value: inner } })
  // The change feed is constructed with the service's context, so it needs the
  // same redirection; its follower bookkeeping stays on the shared instance.
  if (service.feed) Object.defineProperty(receiver, 'feed', { value: Object.create(service.feed, { ctx: { value: inner } }) })
  return receiver
}

/** Find a method and its descriptor anywhere on the service instance. */
function findMethod(service, name) {
  let owner = service
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)
    if (descriptor) return { owner, descriptor }
    owner = Object.getPrototypeOf(owner)
  }
  return undefined
}

/** One world per server, directory and authentication identity. */
function worldKey(server, cwd) {
  return JSON.stringify([
    server?.id, server?.host, server?.port, server?.username, server?.remoteRoot,
    server?.auth?.type || '', String(cwd || ''),
  ])
}

/**
 * Install the bridge on the deployment's Workspace Files service.
 *
 * The installer waits for the service, patches its instance methods once, and
 * registers restoration plus world disposal as plugin effects. Sessions whose
 * route resolves to a local execution world are never touched.
 *
 * @param ctx - the plugin context (`inject`, `effect`, `logger`).
 * @param options - `route(scope)`, returning `{ server, remotePath?, environment? }`
 *   for a remote Session and `undefined` for a local one, and `createWorld(request)`,
 *   returning `{ fileSystem, environment }` for that world.
 * @returns a handle with the world cache and `dispose`, or `undefined` if the
 *   bridge cannot be installed at all.
 */
export function installWorkspaceFilesBridge(ctx, options = {}) {
  const { route, createWorld } = options
  if (typeof ctx?.inject !== 'function' || typeof route !== 'function' || typeof createWorld !== 'function') return undefined
  const logger = options.logger
  const worlds = new Map()
  const receivers = new Map()

  async function worldFor(request) {
    const key = worldKey(request.server, normalizeRemoteRoot(request.environment?.cwd || request.remotePath || '/'))
    const cached = worlds.get(key)
    if (cached !== undefined) return await cached
    const pending = Promise.resolve().then(() => createWorld(request))
    worlds.set(key, pending)
    try {
      return await pending
    } catch (error) {
      if (worlds.get(key) === pending) worlds.delete(key)
      throw error
    }
  }

  function receiverFor(service, request, world) {
    const remoteRoot = normalizeRemoteRoot(world.environment?.cwd || request.remotePath || '/')
    const key = `${worldKey(request.server, remoteRoot)}|${request.workspaceRoot}`
    let receiver = receivers.get(key)
    if (receiver === undefined) {
      receiver = worldReceiver(service, routedFileSystem(world.fileSystem, request.workspaceRoot, remoteRoot))
      receivers.set(key, receiver)
    }
    return receiver
  }

  /**
   * The receiver and arguments one official body must run with.
   *
   * A locally executed Session keeps the caller: `ctx.fs` and the change feed are
   * already the right ones, so the unpatched behavior is reproduced exactly.
   */
  async function callTarget(service, caller, args) {
    const scope = args[0]
    let destination
    try {
      destination = await route(scope)
    } catch (error) {
      // A route that cannot be resolved must never break a local Workspace: fall
      // back to the untouched body and leave the reason in the log.
      logger?.warn?.(`DSH Remote SSH workspace files bridge route: ${error instanceof Error ? error.message : String(error)}`)
      return { receiver: caller, args }
    }
    if (!destination?.server) return { receiver: caller, args }
    const request = {
      server: destination.server,
      remotePath: destination.remotePath,
      environment: destination.environment,
      workspaceRoot: String(scope?.workspaceRoot || ''),
    }
    const world = await worldFor(request)
    return { receiver: receiverFor(service, request, world), args }
  }

  async function dispatch(original, service, caller, args) {
    const target = await callTarget(service, caller, args)
    return await original.apply(target.receiver, target.args)
  }

  /**
   * Stream answers must be async iterables *synchronously* — the gateway iterates
   * the returned value — so routing happens inside the generator, and the official
   * generator's items and failures are forwarded unchanged.
   */
  async function* stream(original, service, caller, args) {
    const target = await callTarget(service, caller, args)
    yield* await original.apply(target.receiver, target.args)
  }

  function dispose() {
    const pending = [...worlds.values()]
    worlds.clear()
    receivers.clear()
    for (const world of pending) {
      Promise.resolve(world).then(value => value?.fiber?.dispose?.()).catch(() => void 0)
    }
  }

  function install(inner) {
    const provided = inner.workspaceFiles ?? (typeof inner.get === 'function' ? inner.get('workspaceFiles') : undefined)
    const service = provided === undefined ? undefined : Reflect.get(provided, ORIGINAL) ?? provided
    if (service === undefined || service === null || typeof service !== 'object') {
      logger?.warn?.('DSH Remote SSH workspace files bridge: the Workspace Files service is unavailable')
      return
    }
    if (service[BRIDGE] !== undefined) return
    const restore = []
    for (const name of ROUTED_METHODS) {
      const found = findMethod(service, name)
      if (typeof found?.descriptor?.value !== 'function') continue
      const { owner, descriptor } = found
      const original = descriptor.value
      const patched = STREAM_METHODS.has(name)
        ? function patched(...args) {
          return stream(original, service, this, args)
        }
        : function patched(...args) {
          return dispatch(original, service, this, args)
        }
      Object.defineProperty(service, name, {
        value: patched,
        writable: true,
        configurable: true,
        enumerable: false,
      })
      restore.push(() => {
        if (owner === service) Object.defineProperty(service, name, descriptor)
        else delete service[name]
      })
    }
    Object.defineProperty(service, BRIDGE, {
      value: {
        restore() {
          while (restore.length > 0) restore.pop()()
          delete service[BRIDGE]
        },
        dispose,
      },
      configurable: true,
      enumerable: false,
    })
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        service[BRIDGE]?.restore()
        dispose()
      }, 'DSH Remote SSH workspace files bridge')
    }
    logger?.info?.(`DSH Remote SSH workspace files bridge installed on ${restore.length} method(s)`)
    if (restore.length < ROUTED_METHODS.length) {
      logger?.warn?.(`DSH Remote SSH workspace files bridge: ${ROUTED_METHODS.length - restore.length} of ${ROUTED_METHODS.length} Remote method(s) are missing from the service`)
    }
  }

  try {
    ctx.inject(['workspaceFiles'], inner => {
      try {
        install(inner)
      } catch (error) {
        logger?.warn?.(`DSH Remote SSH workspace files bridge: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    logger?.warn?.(`DSH Remote SSH workspace files bridge: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  return { worlds, dispose }
}
