import { ConnectionManager, RemoteRuntimeError } from './connection-manager.js'
import { SshFileSystem, listRemoteDirectories, remoteDirectoryInfo, resolveRemoteEnvironment } from './remote-fs.js'
import { SshSubprocessRuntime } from './remote-subprocess.js'
import { mountRemoteExecutionRealm, mountRemoteFilesystem } from './remote-realm.js'
import { installWorkspaceFilesBridge } from './workspace-files-bridge.js'
import {
  folderWorkspaceDir,
  locationForSessionCwd,
  serverWorkspaceDir,
  serverWorkspaceTitle,
  syncFolderWorkspace,
  syncFolderWorkspaces,
  syncServerWorkspace,
  syncServerWorkspaces,
  uniqueFolderWorkspaceTitle,
  workspaceDirs,
} from './server-workspace.js'
import { RuntimeStore } from './store.js'
import { publicServer, validateServerInput } from './utils.js'

export const name = 'dsh-remote-ssh'
export const inject = ['connection', 'agents', 'sessions', 'systemPrompt']

function sessionIdOf(agent) {
  return String(agent?.session?.id ?? agent?.id ?? '')
}

function rpcError(error, signal) {
  if (signal?.aborted) return { code: 'CANCELLED', message: '操作已取消', details: {} }
  if (error instanceof RemoteRuntimeError) return { code: error.code, message: error.message, details: error.details || {} }
  return {
    code: error?.code || 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    details: error?.details || {},
  }
}

function registerCleanup(ctx, cleanup, label) {
  if (typeof cleanup !== 'function') return
  if (ctx.effect) ctx.effect(() => cleanup, label)
}

function serverSignature(server) {
  if (!server) return ''
  return JSON.stringify({
    id: server.id,
    host: server.host,
    port: server.port,
    username: server.username,
    auth: server.auth,
    remoteRoot: server.remoteRoot,
    hostKeyFingerprint: server.hostKeyFingerprint,
  })
}

function targetEquals(left, right) {
  if (left?.type !== right?.type) return false
  return left?.type !== 'ssh' || String(left.serverId || '') === String(right.serverId || '')
}

function hostPlatformName() {
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'linux') return 'Linux'
  return process.platform
}

function targetLabel(target, server) {
  if (target?.type === 'ssh') {
    return {
      type: 'ssh',
      identity: `server:${String(target.serverId || server?.id || '')}`,
      name: String(server?.name || '服务器'),
      platform: 'Linux',
    }
  }
  return { type: 'local', identity: 'local', name: '本地电脑', platform: hostPlatformName() }
}

function latestAssistantMessageId(agent) {
  const events = agent?.session?.events
  if (!events || typeof events[Symbol.iterator] !== 'function') return undefined
  const values = Array.from(events)
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const event = values[index]
    if (event?.type !== 'assistant/message') continue
    const messageId = String(event?.data?.message?.id || '').trim()
    if (messageId) return messageId
  }
  return undefined
}

export async function apply(ctx, config = {}) {
  const baseDir = config.stateDir || process.cwd()
  const store = new RuntimeStore({
    baseDir,
    ...(config.stateFile ? { file: config.stateFile } : {}),
  })
  await store.ready()

  // Connections are Host-scoped and pooled. Execution providers and prompt
  // context remain Agent-scoped so multiple conversations can use the same TCP
  // connection without sharing fs/subprocess service instances.
  const connections = new ConnectionManager({ connectTimeoutMs: config.connectTimeoutMs || 10_000 })
  const knownAgents = new Map()
  const running = new Set()
  const frozen = new Map()
  const realms = new Map()
  const realmOps = new Map()
  const executionContexts = new Map()

  // Workspace registration is an optional capability: a Host that mounts no
  // workspace service still gets remote execution, so this plugin keeps
  // `workspaceRegistry` OUT of its own inject list. `ctx.inject` starts a scoped
  // child fiber that does receive the service — which both resolves cordis
  // service visibility (a sibling's service is invisible to this fiber) and
  // removes the activation race: the callback runs whenever the registry is
  // actually there, however late that is.
  const registryReady = (() => {
    let settle
    const promise = new Promise(resolve => { settle = resolve })
    try {
      if (typeof ctx.inject === 'function') ctx.inject(['workspaceRegistry'], inner => settle(inner))
      else settle(undefined)
    } catch (error) {
      ctx.logger?.debug?.(`DSH Remote SSH workspace service unavailable: ${String(error)}`)
      settle(undefined)
    }
    return promise
  })()

  /** The injected context owning `workspaceRegistry`, or `undefined` if absent. */
  function workspaceContext(timeoutMs = 0) {
    if (!timeoutMs) return registryReady
    return Promise.race([
      registryReady,
      new Promise(resolve => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs)
        timer.unref?.()
      }),
    ])
  }

  async function requireWorkspaceContext() {
    const inner = await workspaceContext(5_000)
    if (!inner || !inner.workspaceRegistry) {
      throw new Error('当前 DSH 没有挂载工作区服务（workspaceRegistry），无法把服务器或远端目录加为工作区')
    }
    return inner
  }

  /** Every remembered remote directory, with the staging directory it owns. */
  function folderWorkspaceViews() {
    const servers = store.listServersNow()
    return store.listFolderWorkspacesNow().map(folder => ({
      ...folder,
      dir: folderWorkspaceDir(baseDir, folder.serverId, folder.remotePath),
      serverName: servers.find(server => server.id === folder.serverId)?.name || folder.serverId,
    }))
  }

  // A deleted server takes its remote-directory workspaces with it: those
  // staging directories cannot execute anything any more. Only the Workspace
  // registrations go — the directories themselves are left on disk.
  async function forgetFolderWorkspaces(serverId, folders) {
    if (!folders?.length) return
    const inner = await workspaceContext(3_000)
    const registry = inner?.workspaceRegistry
    if (!registry || typeof registry.delete !== 'function') return
    for (const folder of folders) {
      const dir = folderWorkspaceDir(baseDir, serverId, folder.remotePath)
      try {
        const workspace = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(dir) : undefined
        if (workspace?.id) await registry.delete(workspace.id)
      } catch (error) {
        ctx.logger?.warn?.(`DSH Remote SSH folder workspace removal ${serverId}:${folder.remotePath}: ${String(error)}`)
      }
    }
  }

  function agentForSession(sessionId) {
    const id = String(sessionId || '')
    if (!id) return undefined
    const known = knownAgents.get(id)
    if (known) return known
    try { return ctx.agents.get(id) } catch { return undefined }
  }

  function handoffAnchor(sessionId) {
    return latestAssistantMessageId(agentForSession(sessionId))
  }

  async function appendHandoffTimelineEvent(sessionId, handoff) {
    const id = String(sessionId || '')
    if (!id || !handoff?.anchorMessageId) return
    const session = agentForSession(id)?.session
    if (!session || typeof session.append !== 'function') return
    const payload = {
      handoffId: `handoff:${handoff.generation}:${handoff.time}`,
      generation: Number(handoff.generation || 0),
      time: Number(handoff.time || Date.now()),
      from: handoff.from,
      to: handoff.to,
    }
    try {
      session.append('dsh-remote-ssh/execution-handoff', payload)
      try { await ctx.sessions?.flush?.(session) } catch (error) {
        ctx.logger?.warn?.(`DSH Remote SSH handoff timeline flush ${id}: ${String(error)}`)
      }
    } catch (error) {
      // The execution handoff itself is authoritative. A presentation-event
      // failure must never roll the session back to the previous machine.
      ctx.logger?.warn?.(`DSH Remote SSH handoff timeline append ${id}: ${String(error)}`)
    }
  }

  function pendingHandoffContext(sessionId) {
    const id = String(sessionId || '')
    if (!id) return undefined
    const acknowledged = store.getHandoffContextAckNow(id)
    const pending = store.listHandoffsNow(id)
      .filter(item => item.generation > acknowledged && item.anchorMessageId)
      .sort((left, right) => left.generation - right.generation)
    if (!pending.length) return undefined
    const first = pending[0]
    const latest = pending[pending.length - 1]
    const sameEnvironment = first.from.type === latest.to.type
      && (first.from.identity && latest.to.identity
        ? first.from.identity === latest.to.identity
        : first.from.name === latest.to.name && first.from.platform === latest.to.platform)
    return {
      generation: latest.generation,
      from: first.from,
      to: latest.to,
      sameEnvironment,
    }
  }

  function frozenTarget(sessionId) {
    return frozen.get(String(sessionId))
  }

  // Where a Session's Workspace says it must run: the server of the Workspace
  // that contains its canonical cwd, plus the remote directory when that
  // Workspace is a remote-directory child (`<staging>/<serverId>/<slug>`).
  function workspaceLocation(sessionId) {
    const id = String(sessionId || '')
    if (!id) return undefined
    const cwd = agentForSession(id)?.session?.header?.cwd
    return locationForSessionCwd(baseDir, store.listServersNow(), store.listFolderWorkspacesNow(), cwd)
  }

  // Every server owns a real DSH Workspace (see ./server-workspace.js), so a
  // conversation started inside that Workspace already means "run on this
  // server". Adopting the target here keeps the workspace workflow one click:
  // open the server's group in the left column, start a conversation, and it
  // executes remotely. An explicit selection by the user always wins.
  function workspaceTarget(sessionId) {
    const id = String(sessionId || '')
    if (!id || store.hasTargetNow(id)) return undefined
    const location = workspaceLocation(id)
    return location ? { type: 'ssh', serverId: location.server.id } : undefined
  }

  async function persistWorkspaceTarget(sessionId) {
    const id = String(sessionId || '')
    if (!id) return
    const target = workspaceTarget(id)
    if (!target) return
    const server = store.getServerNow(target.serverId)
    if (!server) return
    try {
      await store.setTarget(id, target)
      ctx.logger?.info?.(`DSH Remote SSH workspace adoption ${id} -> ${server.name} (${serverWorkspaceDir(baseDir, server.id)})`)
    } catch (error) {
      ctx.logger?.warn?.(`DSH Remote SSH workspace adoption ${id}: ${String(error)}`)
    }
  }

  function desiredTarget(sessionId) {
    const snapshot = frozenTarget(sessionId)
    if (snapshot?.target) return snapshot.target
    const explicit = store.getTargetNow(sessionId)
    if (explicit?.type === 'ssh') return explicit
    return workspaceTarget(sessionId) || explicit
  }

  function desiredServer(sessionId) {
    const snapshot = frozenTarget(sessionId)
    if (snapshot?.server) return snapshot.server
    const target = desiredTarget(sessionId)
    return target?.type === 'ssh' ? store.getServerNow(target.serverId) : undefined
  }

  function busyUsingServer(serverId) {
    for (const snapshot of frozen.values()) {
      if (snapshot.target?.type === 'ssh' && snapshot.target.serverId === serverId) return true
    }
    return false
  }

  function executionView(sessionId) {
    const id = String(sessionId)
    const agent = knownAgents.get(id)
    const target = desiredTarget(id)
    const generation = store.getGenerationNow(id)
    if (target.type === 'ssh') {
      const server = desiredServer(id)
      const current = realms.get(id)
      const location = workspaceLocation(id)
      return {
        type: 'ssh',
        name: String(server?.name || '服务器'),
        platform: 'Linux',
        cwd: String(current?.environment?.cwd || current?.handle?.remoteRoot || location?.remotePath || server?.remoteRoot || '~'),
        generation,
      }
    }
    return {
      type: 'local',
      name: '本地电脑',
      platform: hostPlatformName(),
      cwd: String(agent?.session?.header?.cwd || process.cwd()),
      generation,
    }
  }

  function renderExecutionContext(sessionId) {
    const view = executionView(sessionId)
    // A never-switched local conversation stays byte-for-byte stock DSH. Every
    // other world contributes only CURRENT runtime facts. If an idle handoff
    // occurred after this conversation had durable assistant history, one
    // transient provenance sentence is included in the NEXT accepted model
    // step only. The following runtime-context snapshot returns to current-only
    // facts, letting DSH's own snapshot replacement semantics retire the notice.
    if (view.type === 'local' && view.generation === 0) return ''
    const lines = [
      `Current execution environment: ${JSON.stringify(view.name)}.`,
      `Operating system: ${view.platform}.`,
      `Current working directory: ${JSON.stringify(view.cwd)}.`,
      'The DSH filesystem, shell, search, and terminal tools operate in this execution environment.',
    ]
    const handoff = pendingHandoffContext(sessionId)
    if (handoff && !handoff.sameEnvironment) {
      lines.push(
        `An execution-environment handoff just occurred from ${JSON.stringify(handoff.from.name)} (${handoff.from.platform}) to ${JSON.stringify(handoff.to.name)} (${handoff.to.platform}). Earlier conversation and project context remain available, while machine-specific observations made before this handoff describe the previous execution environment.`,
      )
    }
    return lines.join(' ')
  }

  function disposeExecutionContext(sessionId) {
    const id = String(sessionId)
    const current = executionContexts.get(id)
    executionContexts.delete(id)
    if (!current) return
    for (const dispose of current.disposers) {
      try { dispose?.() } catch {}
    }
  }

  function ensureExecutionContext(agent) {
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return
    const existing = executionContexts.get(sessionId)
    if (existing?.agent === agent) return
    if (existing) disposeExecutionContext(sessionId)

    const scoped = agent?.ctx
    if (!scoped?.systemPrompt?.context || typeof scoped?.on !== 'function') {
      ctx.logger?.warn?.(`DSH Remote SSH execution context ${sessionId}: scoped systemPrompt is unavailable`)
      return
    }

    const disposers = []
    try {
      disposers.push(scoped.systemPrompt.context({
        name: 'dsh-remote-ssh:execution-world',
        order: 10_000,
        text: () => renderExecutionContext(sessionId),
      }))

      // DSH's persona resolves {{cwd}} from immutable SessionHeader.cwd. Keep
      // that Session/Workspace identity untouched for sidebar/history grouping,
      // but make the model-facing cwd reflect the active execution world. This
      // is an Execution Handoff, not a Workspace mutation.
      disposers.push(scoped.on('system-prompt/assemble', async (assembly, _assembleContext, next) => {
        const transformed = await next()
        const view = executionView(sessionId)
        return {
          ...transformed,
          variables: { ...transformed.variables, cwd: view.cwd },
        }
      }))

      executionContexts.set(sessionId, { agent, disposers })
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        try { dispose?.() } catch {}
      }
      ctx.logger?.warn?.(`DSH Remote SSH execution context ${sessionId}: ${String(error)}`)
    }
  }

  async function disposeRealm(sessionId) {
    const id = String(sessionId)
    const current = realms.get(id)
    realms.delete(id)
    if (!current) return
    try { await current.handle.dispose() }
    catch (error) { ctx.logger?.warn?.(`DSH Remote SSH dispose realm ${id}: ${String(error)}`) }
  }

  async function syncAgentRealm(agent) {
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return
    knownAgents.set(sessionId, agent)
    ensureExecutionContext(agent)

    const previous = realmOps.get(sessionId) || Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      // Child/subagents inherit their parent's execution world. The child keeps
      // its own Agent service realm; only target selection is inherited.
      if (!store.hasTargetNow(sessionId)) {
        const parentSession = String(agent?.session?.header?.parentSession || '')
        if (parentSession) {
          const parentTarget = desiredTarget(parentSession)
          if (parentTarget.type === 'ssh') {
            await store.setTarget(sessionId, parentTarget)
            ctx.logger?.info?.(`DSH Remote SSH inherited execution world ${sessionId} <- ${parentSession} (${parentTarget.serverId})`)
          }
        }
      }

      const target = desiredTarget(sessionId)
      if (target.type !== 'ssh') {
        await disposeRealm(sessionId)
        return
      }
      const server = desiredServer(sessionId)
      if (!server) {
        await disposeRealm(sessionId)
        throw new Error('选择的远程服务器不存在')
      }

      // A Session opened inside a remote-directory Workspace runs in that very
      // directory; the resolved cwd is part of the realm identity, so moving
      // between the server root and one of its directories remounts.
      const location = workspaceLocation(sessionId)
      const desiredCwd = location?.server?.id === server.id ? location.remotePath : undefined
      const signature = `${serverSignature(server)}|cwd:${desiredCwd || ''}`
      const current = realms.get(sessionId)
      if (current?.serverId === server.id && current.signature === signature) return

      await disposeRealm(sessionId)
      const environment = await resolveRemoteEnvironment(connections, server, desiredCwd ? { cwd: desiredCwd } : {})
      const handle = await mountRemoteExecutionRealm(agent, {
        server,
        connections,
        resolvedEnvironment: environment,
        diffBasisMaxBytes: config.diffBasisMaxBytes,
        defaultTimeoutMs: config.defaultTimeoutMs,
        maxTimeoutMs: config.maxTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        maxSpillBytes: config.maxSpillBytes,
        graceMs: config.graceMs,
      })
      realms.set(sessionId, { serverId: server.id, signature, environment, handle })
      ctx.logger?.info?.(`DSH Remote SSH execution world ${sessionId} -> ${server.name} (${server.username}@${server.host}:${server.port}) cwd=${environment.cwd}`)
    })
    realmOps.set(sessionId, operation)
    try { await operation }
    finally { if (realmOps.get(sessionId) === operation) realmOps.delete(sessionId) }
  }

  async function syncSessionRealm(sessionId) {
    const agent = agentForSession(sessionId)
    if (agent) await syncAgentRealm(agent)
  }

  async function refreshRealmsUsingServer(serverId) {
    const tasks = []
    for (const [sessionId, agent] of knownAgents) {
      const target = desiredTarget(sessionId)
      if (target.type === 'ssh' && target.serverId === serverId) tasks.push(syncAgentRealm(agent))
    }
    await Promise.all(tasks)
  }

  ctx.on('agent/created', ({ agent }) => {
    const id = sessionIdOf(agent)
    if (id) knownAgents.set(id, agent)
    ensureExecutionContext(agent)
    void persistWorkspaceTarget(id)
    // Warm composition early. agent/pre-step below is the authoritative gate.
    void syncAgentRealm(agent).catch(error => ctx.logger?.warn?.(`DSH Remote SSH initial realm ${id}: ${String(error)}`))
  })

  ctx.on('agent/session-start', ({ agent }) => {
    const id = sessionIdOf(agent)
    if (id) knownAgents.set(id, agent)
    ensureExecutionContext(agent)
    void persistWorkspaceTarget(id)
    void syncAgentRealm(agent).catch(error => ctx.logger?.warn?.(`DSH Remote SSH session realm ${id}: ${String(error)}`))
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const id = sessionIdOf(agent)
    if (!id) return
    knownAgents.set(id, agent)
    ensureExecutionContext(agent)
    if (status === 'running') {
      running.add(id)
      const target = desiredTarget(id)
      const server = target.type === 'ssh' ? store.getServerNow(target.serverId) : undefined
      frozen.set(id, {
        target: structuredClone(server ? target : { type: 'local' }),
        ...(server ? { server: structuredClone(server) } : {}),
      })
    } else {
      running.delete(id)
      frozen.delete(id)
      void syncAgentRealm(agent).catch(error => ctx.logger?.warn?.(`DSH Remote SSH idle realm ${id}: ${String(error)}`))
    }
  })

  // Composition-readiness gate plus one-shot handoff acknowledgement. DSH
  // assembles runtime context immediately before this waterfall, so the pending
  // handoff provenance has already been captured in the current assembly. Only
  // after downstream listeners ACCEPT the step do we acknowledge that generation;
  // a rejected/aborted proposal therefore cannot consume the one-shot notice.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    await syncAgentRealm(agent)
    const sessionId = sessionIdOf(agent)
    const pending = pendingHandoffContext(sessionId)
    const decision = await next()
    if (pending && decision.kind === 'enter' && !signal.aborted) {
      try {
        await store.acknowledgeHandoffContext(sessionId, pending.generation)
      } catch (error) {
        ctx.logger?.warn?.(`DSH Remote SSH handoff context acknowledgement ${sessionId}: ${String(error)}`)
      }
    }
    return decision
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const id = sessionIdOf(agent)
    knownAgents.delete(id)
    running.delete(id)
    frozen.delete(id)
    disposeExecutionContext(id)
    void disposeRealm(id)
  })

  const stateView = sessionId => {
    const servers = store.listServersNow()
    return {
      servers,
      workspaceDirs: workspaceDirs(baseDir, servers),
      folderWorkspaces: folderWorkspaceViews(),
      target: store.getTargetNow(sessionId),
      generation: store.getGenerationNow(sessionId),
      handoffs: store.listHandoffsNow(sessionId),
      execution: executionView(sessionId),
      busy: running.has(String(sessionId)),
      hostPlatform: process.platform,
      connections: connections.statusMap(servers.map(server => server.id)),
      architecture: 'provider-realm-v3',
    }
  }

  const business = async (method, payload = {}, signal) => {
    const body = payload && typeof payload === 'object' ? payload : {}
    const sessionId = body.sessionId === undefined ? '' : String(body.sessionId)

    switch (String(method)) {
      case 'state':
        if (!sessionId) throw new Error('sessionId is required')
        return stateView(sessionId)

      // Session-independent summary for the left sidebar: the workspace column
      // shows one execution-world badge and one location menu per Session row, and
      // this plugin's server-workspaces panel sits at its foot; none of them knows a
      // Session id up front. `targets` is keyed by Session id so a row can resolve
      // its own state.
      case 'overview': {
        const servers = store.listServersNow()
        return {
          servers,
          workspaceDirs: workspaceDirs(baseDir, servers),
          folderWorkspaces: folderWorkspaceViews(),
          targets: store.listTargetsNow(),
          hostPlatform: process.platform,
          connections: connections.statusMap(servers.map(server => server.id)),
          architecture: 'provider-realm-v3',
        }
      }

      // One SFTP directory listing for the remote folder browser. Servers are
      // browsed directly over SFTP rather than through the Agent-scoped file
      // service, because no Agent exists yet while the user is still choosing a
      // workspace.
      case 'remote.browse': {
        const server = store.getServerNow(String(body.serverId || ''))
        if (!server) throw new Error('服务器不存在')
        const listing = await listRemoteDirectories(connections, server, body.path, {
          signal,
          includeFiles: body.includeFiles === true,
        })
        return { ...listing, serverId: server.id, serverName: server.name }
      }

      // Adopt one server as a Workspace: the durable record the left column
      // shows, whose conversations execute on that server.
      case 'workspace.addServer': {
        const server = store.getServerNow(String(body.serverId || ''))
        if (!server) throw new Error('服务器不存在')
        const inner = await requireWorkspaceContext()
        const dir = serverWorkspaceDir(baseDir, server.id)
        const existing = store.getServerNow(server.id)
        const workspace = await syncServerWorkspace(inner, baseDir, server, ctx.logger)
        if (!workspace) throw new Error('工作区服务没有返回工作区记录')
        ctx.logger?.info?.(`DSH Remote SSH server workspace requested ${server.name} -> ${dir} (${workspace.id})`)
        return {
          serverId: server.id,
          workspaceId: String(workspace.id),
          dir: String(workspace.path || dir),
          title: String(workspace.title || serverWorkspaceTitle(existing || server)),
        }
      }

      // Adopt one remote directory as a child Workspace of its server. Both the
      // parent and the child are registered here, so the child always nests under
      // the server row however it was created.
      case 'workspace.addFolder': {
        const server = store.getServerNow(String(body.serverId || ''))
        if (!server) throw new Error('服务器不存在')
        const requested = String(body.path || '').trim()
        if (!requested) throw new Error('请选择一个远端目录')
        const target = await remoteDirectoryInfo(connections, server, requested, { signal })
        const inner = await requireWorkspaceContext()
        await syncServerWorkspace(inner, baseDir, server, ctx.logger)
        const remembered = store.getFolderWorkspaceNow(server.id, target.path)
        const siblingTitles = new Set(
          store.listFolderWorkspacesNow(server.id)
            .filter(folder => folder.remotePath !== target.path)
            .map(folder => folder.title),
        )
        const title = remembered?.title || uniqueFolderWorkspaceTitle(target.path, siblingTitles)
        const workspace = await syncFolderWorkspace(inner, baseDir, server, target.path, { logger: ctx.logger, title })
        if (!workspace) throw new Error('工作区服务没有返回工作区记录')
        await store.upsertFolderWorkspace({
          serverId: server.id,
          remotePath: target.path,
          title,
          workspaceId: String(workspace.id),
        })
        ctx.logger?.info?.(`DSH Remote SSH folder workspace ${server.id}:${target.path} -> ${workspace.path} (${workspace.id})`)
        return {
          serverId: server.id,
          remotePath: target.path,
          workspaceId: String(workspace.id),
          dir: String(workspace.path || folderWorkspaceDir(baseDir, server.id, target.path)),
          title: String(workspace.title || title),
          created: !remembered,
        }
      }

      // Forget one remote directory: the plugin stops remembering it, and its
      // Workspace registration goes with the memory (`forgetFolderWorkspaces`),
      // the same cascade a deleted server runs. The staging directory and any
      // Sessions inside it stay on disk, so nothing the user did is destroyed —
      // re-picking the same directory registers it again.
      case 'workspace.forgetFolder': {
        const serverId = String(body.serverId || '')
        const remotePath = String(body.remotePath || body.path || '').trim()
        if (!serverId || !remotePath) throw new Error('serverId and remotePath are required')
        const removed = await store.removeFolderWorkspace(serverId, remotePath)
        if (removed) await forgetFolderWorkspaces(serverId, [{ remotePath }])
        return { removed }
      }

      case 'server.test': {
        const candidate = validateServerInput(body.server, body.server?.id)
        const peer = `${candidate.username}@${candidate.host}:${candidate.port}`
        ctx.logger?.info?.(`DSH Remote SSH SSH test ${peer} start`)
        const result = await connections.test(candidate, {
          signal,
          allowFingerprint: body.allowFingerprint ? String(body.allowFingerprint) : undefined,
          onStage: stage => ctx.logger?.info?.(`DSH Remote SSH SSH test ${peer} stage=${stage}`),
        })
        ctx.logger?.info?.(`DSH Remote SSH SSH test ${peer} complete auth=${result.auth}`)
        return { ...result, server: { ...publicServer(candidate), hostKeyFingerprint: result.fingerprint } }
      }


      case 'server.testAndSave': {
        const input = body.server
        const existingId = input?.id ? String(input.id) : undefined
        if (existingId && busyUsingServer(existingId)) throw new Error('Agent 正在使用这台服务器，当前不能修改连接信息')
        const old = existingId ? store.getServerNow(existingId) : undefined
        const affected = old ? store.sessionIdsUsingServerNow(existingId) : []
        const oldSignature = serverSignature(old)
        const candidate = validateServerInput(input, existingId)
        const peer = `${candidate.username}@${candidate.host}:${candidate.port}`
        const password = candidate.auth?.type === 'password' && typeof body.password === 'string' && body.password
          ? body.password
          : undefined
        ctx.logger?.info?.(`DSH Remote SSH SSH test+save ${peer} start`)
        const result = await connections.test(candidate, {
          signal,
          password,
          allowFingerprint: body.allowFingerprint ? String(body.allowFingerprint) : undefined,
          onStage: stage => ctx.logger?.info?.(`DSH Remote SSH SSH test+save ${peer} stage=${stage}`),
        })
        const tested = { ...candidate, hostKeyFingerprint: result.fingerprint }
        const saved = await store.upsertServer(tested)
        if (old) connections.invalidate(saved.id)
        if (tested.auth?.type === 'password') {
          if (password) connections.rememberPassword(saved.id, password)
        } else {
          connections.forgetPassword(saved.id)
        }
        await refreshRealmsUsingServer(saved.id)
        await ensureWorkspaceForServer(saved)
        const next = store.getServerNow(saved.id)
        if (old && oldSignature !== serverSignature(next)) await store.bumpGenerations(affected)
        ctx.logger?.info?.(`DSH Remote SSH SSH test+save ${peer} complete auth=${result.auth}`)
        return { ...result, server: saved }
      }

      case 'server.upsert': {
        const input = body.server
        const existingId = input?.id ? String(input.id) : undefined
        if (existingId && busyUsingServer(existingId)) throw new Error('Agent 正在使用这台服务器，当前不能修改连接信息')
        const old = existingId ? store.getServerNow(existingId) : undefined
        const affected = old ? store.sessionIdsUsingServerNow(existingId) : []
        const oldSignature = serverSignature(old)
        const saved = await store.upsertServer(input)
        if (old) connections.invalidate(saved.id)
        if (store.getServerNow(saved.id)?.auth?.type !== 'password') connections.forgetPassword(saved.id)
        await refreshRealmsUsingServer(saved.id)
        await ensureWorkspaceForServer(saved)
        const next = store.getServerNow(saved.id)
        if (old && oldSignature !== serverSignature(next)) await store.bumpGenerations(affected)
        return { server: saved }
      }

      case 'server.remove': {
        const id = String(body.serverId || '')
        if (!id) throw new Error('serverId is required')
        if (busyUsingServer(id)) throw new Error('Agent 正在使用这台服务器，当前不能删除')
        const affected = store.sessionIdsUsingServerNow(id)
        const removedServer = store.getServerNow(id)
        const removedFolders = store.listFolderWorkspacesNow(id)
        const removed = await store.removeServer(id)
        connections.invalidate(id)
        connections.forgetPassword(id)
        void forgetFolderWorkspaces(id, removedFolders)
        await Promise.all(affected.map(knownSessionId => syncSessionRealm(knownSessionId)))
        if (removed && removedServer) {
          for (const affectedSessionId of affected) {
            const handoff = {
              generation: store.getGenerationNow(affectedSessionId),
              time: Date.now(),
              from: targetLabel({ type: 'ssh', serverId: id }, removedServer),
              to: targetLabel({ type: 'local' }),
              anchorMessageId: handoffAnchor(affectedSessionId),
            }
            await store.recordHandoff(affectedSessionId, handoff)
            await appendHandoffTimelineEvent(affectedSessionId, handoff)
          }
        }
        return { removed }
      }

      case 'server.reconnect': {
        const id = String(body.serverId || '')
        const server = store.getServerNow(id)
        if (!server) throw new Error('服务器不存在')
        connections.invalidate(id)
        await connections.ensure(server, { signal })
        return stateView(sessionId)
      }

      case 'target.set': {
        if (!sessionId) throw new Error('sessionId is required')
        if (running.has(sessionId)) throw new Error('Agent 正在运行，本轮执行位置已经锁定')
        const previous = store.getTargetNow(sessionId)
        const next = body.target?.type === 'ssh'
          ? { type: 'ssh', serverId: String(body.target.serverId || '') }
          : { type: 'local' }
        const server = next.type === 'ssh' ? store.getServerNow(next.serverId) : undefined
        if (next.type === 'ssh' && !server) throw new Error('选择的服务器不存在')

        // Connectivity is validated before changing the session's logical
        // execution world. The DSH Session and left-side Workspace stay intact.
        if (server) await connections.ensure(server, { signal })
        const changed = !targetEquals(previous, next)
        // The UI marker is anchored to the last durable assistant message that
        // already exists at the moment of the idle handoff. This preserves the
        // exact timeline boundary without writing a custom event into DSH's log.
        const anchorMessageId = changed ? handoffAnchor(sessionId) : undefined
        await store.setTarget(sessionId, next, { bumpGeneration: false })
        try {
          await syncSessionRealm(sessionId)
        } catch (error) {
          await store.setTarget(sessionId, previous, { bumpGeneration: false })
          await syncSessionRealm(sessionId).catch(() => {})
          throw error
        }
        if (changed) {
          const generation = await store.bumpGeneration(sessionId)
          const previousServer = previous.type === 'ssh' ? store.getServerNow(previous.serverId) : undefined
          const handoff = {
            generation,
            time: Date.now(),
            from: targetLabel(previous, previousServer),
            to: targetLabel(next, server),
            anchorMessageId,
          }
          await store.recordHandoff(sessionId, handoff)
          await appendHandoffTimelineEvent(sessionId, handoff)
        }
        ctx.logger?.info?.(`DSH Remote SSH execution handoff ${sessionId}: ${previous.type === 'ssh' ? previous.serverId : 'local'} -> ${next.type === 'ssh' ? next.serverId : 'local'} generation=${store.getGenerationNow(sessionId)}`)
        return stateView(sessionId)
      }

      default:
        throw new Error(`unknown remote runtime RPC method: ${String(method)}`)
    }
  }

  // DSH Connection owns the outer transport envelope. Domain errors stay in a
  // successful transport value so plugin-specific codes survive intact.
  const rpcHandler = async (method, payload = {}, signal) => {
    try {
      return { ok: true, value: { dshrs: 1, ok: true, value: await business(method, payload, signal) } }
    } catch (error) {
      const normalized = rpcError(error, signal)
      ctx.logger?.warn?.(`DSH Remote SSH RPC ${String(method)} failed [${normalized.code}]: ${normalized.message}`)
      return { ok: true, value: { dshrs: 1, ok: false, error: normalized } }
    }
  }

  // DSH 0.2.x serves browser RPC on the shared `/api` Fetch surface rather than
  // on per-plugin channels: `connection.rpc.handle` installs its webserver route
  // from the connection service context, which does not inject `webServer`, so
  // that entry point can no longer create a channel route. Exact Fetch routes are
  // the supported seam — they inherit the browser authentication fence and the
  // buffered JSON bridge, and they simply stay absent in profiles without a web
  // server. Each route carries one business method, so the client keeps calling
  // `POST /api/dsh-remote-ssh/<method>`.
  const REMOTE_RUNTIME_METHODS = [
    'state',
    'overview',
    'server.test',
    'server.testAndSave',
    'server.upsert',
    'server.remove',
    'server.reconnect',
    'target.set',
    'remote.browse',
    'workspace.addServer',
    'workspace.addFolder',
    'workspace.forgetFolder',
  ]

  const domainEnvelope = result => Response.json(result, { headers: { 'cache-control': 'no-store' } })

  const registerRemoteRuntimeRoute = method => {
    if (typeof ctx.connection?.fetch?.register !== 'function') {
      ctx.logger?.warn?.(`DSH Remote SSH: connection.fetch.register is unavailable, ${method} route not installed`)
      return
    }
    const path = `/api/dsh-remote-ssh/${method}`
    registerCleanup(
      ctx,
      ctx.connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          let payload = {}
          try {
            const text = await request.text()
            if (text) {
              const body = JSON.parse(text)
              if (body && typeof body === 'object' && body.payload && typeof body.payload === 'object') payload = body.payload
            }
          } catch {
            return domainEnvelope({ ok: true, value: { dshrs: 1, ok: false, error: rpcError(new Error('请求体不是合法 JSON'), undefined) } })
          }
          return domainEnvelope(await rpcHandler(method, payload, request.signal))
        },
      }),
      `DSH Remote SSH remote runtime route ${path}`,
    )
  }

  for (const method of REMOTE_RUNTIME_METHODS) registerRemoteRuntimeRoute(method)

  // Every configured server becomes a real DSH Workspace titled after the
  // server, and every remembered remote directory becomes a child Workspace of
  // its server. Because a child's staging directory lives *inside* the server's
  // staging directory, DSH's own path-containment grouping nests it under the
  // server row — the sub-workspace tree needs no UI of its own.
  //
  // Registration is retried from three directions on purpose: the workspace
  // service may mount before this plugin, after it (`registryReady`), or be
  // replaced later, and Host `ready` covers a registry that exists but is not
  // accepting mutations yet. The operation is idempotent (`resolveByPath` first).
  async function syncWorkspaceRegistrations(reason) {
    const inner = await workspaceContext(5_000)
    if (!inner || !inner.workspaceRegistry) {
      ctx.logger?.debug?.(`DSH Remote SSH workspaces skipped (${reason}): no workspace service mounted`)
      return
    }
    const servers = store.listServersNow()
    const created = await syncServerWorkspaces(inner, baseDir, servers, ctx.logger)
    if (created.length) {
      ctx.logger?.info?.(`DSH Remote SSH server workspaces ready (${reason}): ${created.map(item => `${item.serverId}->${item.workspaceId}`).join(', ')}`)
    }
    const folders = await syncFolderWorkspaces(inner, baseDir, servers, store.listFolderWorkspacesNow(), ctx.logger)
    // A Workspace id can change when the user deletes the record in DSH's own UI,
    // so the durable mapping is refreshed from what the registry just reported.
    for (const item of folders) {
      const remembered = store.getFolderWorkspaceNow(item.serverId, item.remotePath)
      if (!remembered || remembered.workspaceId === item.workspaceId) continue
      await store.upsertFolderWorkspace({ ...remembered, workspaceId: item.workspaceId })
    }
    if (folders.length) {
      ctx.logger?.info?.(`DSH Remote SSH folder workspaces ready (${reason}): ${folders.map(item => `${item.remotePath}->${item.workspaceId}`).join(', ')}`)
    }
  }

  const syncWorkspaces = reason => {
    void syncWorkspaceRegistrations(reason)
      .catch(error => ctx.logger?.warn?.(`DSH Remote SSH workspaces ${reason}: ${String(error)}`))
  }
  syncWorkspaces('activate')
  if (typeof ctx.on === 'function') {
    ctx.on('ready', () => syncWorkspaces('ready'))
  }
  void registryReady.then(inner => { if (inner) syncWorkspaces('registry') })

  async function ensureWorkspaceForServer(server) {
    try {
      const inner = await workspaceContext(2_000)
      if (!inner || !inner.workspaceRegistry) return undefined
      const workspace = await syncServerWorkspace(inner, baseDir, server, ctx.logger)
      if (workspace) {
        ctx.logger?.info?.(`DSH Remote SSH server workspace ${server?.name}: ${workspace.path} (${workspace.id})`)
      }
      return workspace
    } catch (error) {
      ctx.logger?.warn?.(`DSH Remote SSH server workspace ${server?.id}: ${String(error)}`)
      return undefined
    }
  }

  // The right sidebar's Workspace Files tree — and every file it opens — is the
  // official workspace-files Remote, which reads through the deployment-wide
  // (local) filesystem. A Session that executes on a server must therefore be
  // pointed at its execution world: the server it runs on, plus the remote
  // directory when its Workspace is a remote-directory child.
  //
  // The scope DSH hands the Remote carries the Session's *local* staging root as
  // `workspaceRoot`, which is exactly what `locationForSessionCwd` maps back to a
  // server (and a remote directory). A live realm wins over that mapping: it
  // already resolved the world's real working directory and home over SFTP.
  function workspaceFilesDestination(scope) {
    const sessionId = String(scope?.sessionId || '')
    const location = locationForSessionCwd(
      baseDir,
      store.listServersNow(),
      store.listFolderWorkspacesNow(),
      String(scope?.workspaceRoot || ''),
    )
    const target = sessionId ? desiredTarget(sessionId) : undefined
    const server = (target?.type === 'ssh' ? desiredServer(sessionId) : undefined) || location?.server
    if (!server) return undefined
    const remotePath = location?.server?.id === server.id ? location.remotePath : undefined
    const current = sessionId ? realms.get(sessionId) : undefined
    if (current?.environment && current.serverId === server.id && current.signature === `${serverSignature(server)}|cwd:${remotePath || ''}`) {
      return { server, environment: current.environment }
    }
    return remotePath ? { server, remotePath } : { server }
  }

  installWorkspaceFilesBridge(ctx, {
    route: workspaceFilesDestination,
    createWorld: request => mountRemoteFilesystem(ctx, {
      connections,
      diffBasisMaxBytes: config.diffBasisMaxBytes,
      ...request,
    }),
    logger: ctx.logger,
  })

  if (ctx.effect) ctx.effect(() => () => {
    for (const id of [...realms.keys()]) void disposeRealm(id)
    for (const id of [...executionContexts.keys()]) disposeExecutionContext(id)
    knownAgents.clear()
    running.clear()
    frozen.clear()
    void connections.dispose()
  }, 'DSH Remote SSH remote runtime dispose')

  ctx.logger?.info?.(`DSH Remote SSH provider-realm v2 remote runtime ready; state=${store.file}`)
}

export { ConnectionManager, SshFileSystem, SshSubprocessRuntime, RuntimeStore }
