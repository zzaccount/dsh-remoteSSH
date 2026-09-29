// Unit tests for the Workspace Files bridge.
//
// The bridge is what makes the right sidebar's file tree — and every file the
// sidebar or the document preview opens — read a Session's execution world
// instead of the local staging root it carries as `cwd`.
//
// It is pure Host-side logic: path translation plus one service-instance patch.
// These tests therefore need no server, no cordis runtime and no official
// Remote: a fake service whose bodies call `this.ctx.fs` the way the official
// bodies do is enough to prove that a local Session stays untouched, that a
// remote Session is served by the routed world, that paths are rebased, that the
// change feed answers `workspace-file/watch-unsupported`, and that disposing the
// plugin puts the instance back exactly as it was.
import assert from 'node:assert/strict'
import { isAbsolute, join, posix, resolve, sep } from 'node:path'
import test from 'node:test'

import { BRIDGE, installWorkspaceFilesBridge, routedFileSystem, translateWorkspacePath } from '../src/workspace-files-bridge.js'

const REMOTE_ROOT = '/srv/app'
const HOST_ROOT = resolve(sep === '\\' ? 'C:\\stage\\remote-ssh-workspaces\\srv1' : '/stage/remote-ssh-workspaces/srv1')
const OTHER_HOST_ROOT = resolve(join(HOST_ROOT, '..', 'srv2'))
const SERVER = { id: 'srv_1', name: 'dev', host: '10.0.0.1', port: 22, username: 'ubuntu', auth: { type: 'auto' }, remoteRoot: '~' }

function recordingFs(name) {
  const calls = []
  return {
    name,
    calls,
    resolve(path, opts) {
      calls.push(['resolve', path, opts])
      return { targetKey: `${name}:${path}`, displayPath: path }
    },
    lstat(path, opts, signal) {
      calls.push(['lstat', path, opts, signal])
      return { type: 'directory' }
    },
    stat(target, signal) {
      calls.push(['stat', target, signal])
      return { type: 'file', version: `${name}-version`, size: 3 }
    },
    listDir(target) {
      calls.push(['listDir', target])
      return []
    },
    watch(target, listener, signal) {
      calls.push(['watch', target, signal])
      return async () => void 0
    },
  }
}

// The official service body shape: every path is resolved and inspected through
// `this.ctx.fs`, and the change feed is constructed with the service's context.
// The feed mirrors the official sequence — resolve the root, resolve the target,
// stat it, then watch — and reports watch failures the way the official feed
// does, so the bridge is exercised through `this.feed.ctx` as well.
class FakeFeed {
  constructor(ctx) {
    this.ctx = ctx
  }

  async *follow(workspaceRoot, path, signal) {
    const root = await this.ctx.fs.resolve(workspaceRoot, { signal })
    const target = await this.ctx.fs.resolve(path, { cwd: workspaceRoot, signal })
    const info = await this.ctx.fs.stat(target, signal)
    try {
      await this.ctx.fs.watch(target, () => void 0, signal)
    } catch (error) {
      const wrapped = new Error(error instanceof Error ? error.message : String(error))
      wrapped.code = 'workspace-file/watch-unsupported'
      throw wrapped
    }
    yield { kind: 'ready', root, info }
  }
}

class FakeService {
  constructor(ctx) {
    this.ctx = ctx
    this.config = { maxLines: 2000 }
    this.feed = new FakeFeed(ctx)
    this.bodies = []
  }

  async list(scope, path, signal) {
    this.bodies.push(this)
    return {
      root: await this.ctx.fs.resolve(scope.workspaceRoot, { signal }),
      entry: await this.ctx.fs.lstat(path, { cwd: scope.workspaceRoot }, signal),
      entries: await this.ctx.fs.listDir('list-target'),
    }
  }

  async stat(scope, path, signal) {
    this.bodies.push(this)
    const target = await this.ctx.fs.resolve(path, { cwd: scope.workspaceRoot, signal })
    return this.ctx.fs.stat(target, signal)
  }

  changes(scope, path, signal) {
    return this.feed.follow(scope.workspaceRoot, path, signal)
  }
}

function harness(destination, options = {}) {
  const local = recordingFs('local')
  const remote = recordingFs('remote')
  const service = new FakeService({ fs: local })
  const effects = []
  const injected = []
  const created = []
  const logger = { info() {}, warn() {} }
  const ctx = {
    logger,
    inject(names, callback) {
      injected.push(names)
      callback({ workspaceFiles: options.workspaceFiles ?? service })
    },
    effect(factory, label) {
      effects.push({ label, cleanup: factory() })
    },
  }
  const handle = installWorkspaceFilesBridge(ctx, {
    route: destination,
    createWorld(request) {
      created.push(request)
      if (options.createWorld) return options.createWorld(request)
      const environment = request.environment ?? { cwd: request.remotePath || REMOTE_ROOT, home: '/home/ubuntu' }
      return Promise.resolve({ fileSystem: remote, environment })
    },
    logger,
  })
  return { service, local, remote, effects, injected, created, handle, ctx }
}

test('translateWorkspacePath rebases every Host path onto the world', () => {
  assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, HOST_ROOT), REMOTE_ROOT)
  assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, ''), REMOTE_ROOT)
  assert.equal(translateWorkspacePath(HOST_ROOT, `${REMOTE_ROOT}/`, ''), REMOTE_ROOT)
  assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, join(HOST_ROOT, 'sub', 'a.ts')), posix.join(REMOTE_ROOT, 'sub/a.ts'))
  assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, `${HOST_ROOT}/sub/a.ts`), posix.join(REMOTE_ROOT, 'sub/a.ts'))
  assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, 'sub/a.ts'), posix.join(REMOTE_ROOT, 'sub/a.ts'))
  // A Host path outside the workspace has no counterpart in the world, so it lands
  // on the remote root — but only where Host paths and remote paths are spelled
  // differently: on a POSIX Host an absolute path is also a valid remote path, and
  // the bridge hands out absolute remote paths (the `absolutePath` of a stat), so
  // an absolute path outside the root passes through unchanged there.
  const outside = resolve(join(HOST_ROOT, '..', 'other', 'f.ts'))
  if (sep === '\\') {
    assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, outside), REMOTE_ROOT)
    assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, 'D:\\other\\f.ts'), REMOTE_ROOT)
  } else {
    assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, outside), outside)
  }
  // A remote absolute path is what the bridge itself handed out, so it passes through.
  assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, '/srv/app/x.ts'), '/srv/app/x.ts')
  assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, '/etc/../etc/passwd'), '/etc/passwd')
  assert.equal(translateWorkspacePath('', REMOTE_ROOT, '/etc/passwd'), '/etc/passwd')
  assert.equal(translateWorkspacePath('', REMOTE_ROOT, 'rel/x.ts'), posix.join(REMOTE_ROOT, 'rel/x.ts'))
  assert.equal(translateWorkspacePath(HOST_ROOT, '', HOST_ROOT), '/')
})

test('translateWorkspacePath treats a differently cased Host root as the same directory', () => {
  if (sep !== '\\') return
  assert.equal(translateWorkspacePath('c:\\STAGE\\remote-ssh-workspaces\\srv1', REMOTE_ROOT, HOST_ROOT + '\\sub\\b.ts'), posix.join(REMOTE_ROOT, 'sub/b.ts'))
})

test('routedFileSystem translates Host paths and reports watch-unsupported', async () => {
  const fileSystem = recordingFs('world')
  const signal = new AbortController().signal
  const routed = routedFileSystem(fileSystem, HOST_ROOT, REMOTE_ROOT)
  assert.notEqual(routed, fileSystem)
  assert.equal(Object.getPrototypeOf(routed), fileSystem)

  assert.deepEqual(routed.resolve(join(HOST_ROOT, 'sub'), { signal }), { targetKey: `world:${REMOTE_ROOT}/sub`, displayPath: `${REMOTE_ROOT}/sub` })
  assert.deepEqual(fileSystem.calls.at(-1), ['resolve', `${REMOTE_ROOT}/sub`, { signal }])
  routed.resolve(HOST_ROOT)
  assert.deepEqual(fileSystem.calls.at(-1), ['resolve', REMOTE_ROOT, undefined])
  routed.lstat(join(HOST_ROOT, 'sub', 'a.ts'), { cwd: HOST_ROOT }, signal)
  assert.deepEqual(fileSystem.calls.at(-1), ['lstat', `${REMOTE_ROOT}/sub/a.ts`, undefined, signal])
  routed.lstat(HOST_ROOT, { cwd: HOST_ROOT, signal })
  assert.deepEqual(fileSystem.calls.at(-1), ['lstat', REMOTE_ROOT, undefined, signal])

  // Targets produced by the routed calls pass through untouched.
  const target = { targetKey: 'world:target' }
  routed.stat(target)
  assert.deepEqual(fileSystem.calls.at(-1), ['stat', target, undefined])
  await assert.rejects(() => routed.watch(target), /watch-unsupported/)
  assert.equal(fileSystem.calls.some(call => call[0] === 'watch'), false)
})

test('a locally executed Session keeps the untouched service', async () => {
  const { service, local, remote, created, injected } = harness(() => void 0)
  assert.deepEqual(injected, [['workspaceFiles']])
  const signal = new AbortController().signal
  const result = await service.list({ sessionId: 'sess_local', workspaceRoot: HOST_ROOT }, HOST_ROOT, signal)

  assert.deepEqual(local.calls, [['resolve', HOST_ROOT, { signal }], ['lstat', HOST_ROOT, { cwd: HOST_ROOT }, signal], ['listDir', 'list-target']])
  assert.equal(remote.calls.length, 0)
  assert.equal(created.length, 0)
  assert.equal(service.bodies.at(-1), service)
  assert.equal(result.entry.type, 'directory')

  const ready = []
  for await (const item of service.changes({ sessionId: 'sess_local', workspaceRoot: HOST_ROOT }, HOST_ROOT, signal)) ready.push(item)
  assert.deepEqual(ready.map(item => item.kind), ['ready'])
  assert.deepEqual(local.calls.at(-1), ['watch', { targetKey: `local:${HOST_ROOT}`, displayPath: HOST_ROOT }, signal])
})

test('a route that throws falls back to the untouched service', async () => {
  const { service, local, remote, created } = harness(() => {
    throw new Error('store 尚未就绪')
  })
  const signal = new AbortController().signal
  await service.list({ sessionId: 'sess_local', workspaceRoot: HOST_ROOT }, HOST_ROOT, signal)
  assert.deepEqual(local.calls, [['resolve', HOST_ROOT, { signal }], ['lstat', HOST_ROOT, { cwd: HOST_ROOT }, signal], ['listDir', 'list-target']])
  assert.equal(remote.calls.length, 0)
  assert.equal(created.length, 0)
})

test('a remotely executed Session reads the routed world', async () => {
  const destination = scope => scope.sessionId === 'sess_remote' ? { server: SERVER, environment: { cwd: REMOTE_ROOT, home: '/home/ubuntu' } } : void 0
  const { service, local, remote, created } = harness(destination)
  const signal = new AbortController().signal
  const scope = { sessionId: 'sess_remote', workspaceRoot: HOST_ROOT }
  const result = await service.list(scope, join(HOST_ROOT, 'sub'), signal)

  assert.deepEqual(created.map(request => request.server.id), [SERVER.id])
  assert.deepEqual(remote.calls, [
    ['resolve', REMOTE_ROOT, { signal }],
    ['lstat', `${REMOTE_ROOT}/sub`, undefined, signal],
    ['listDir', 'list-target'],
  ])
  assert.equal(local.calls.length, 0)
  assert.equal(result.root.displayPath, REMOTE_ROOT)

  // The official body ran on a receiver pointed at the world, not on the
  // service itself, and it still sees the service's configuration.
  const receiver = service.bodies.at(-1)
  assert.notEqual(receiver, service)
  assert.equal(receiver.config, service.config)
  assert.notEqual(receiver.ctx.fs, service.ctx.fs)
  assert.notEqual(receiver.feed, service.feed)
  assert.equal(service.bodies.length, 1)

  // A second call reuses the same world and the same receiver.
  await service.list(scope, join(HOST_ROOT, 'sub'), signal)
  assert.equal(created.length, 1)
  assert.equal(service.bodies.at(-1), receiver)
  assert.equal(remote.calls.filter(call => call[0] === 'resolve').length, 2)
})

test('each remote directory and workspace gets its own world', async () => {
  const destination = scope => scope.workspaceRoot === OTHER_HOST_ROOT
    ? { server: SERVER, environment: { cwd: '/srv/other', home: '/home/ubuntu' } }
    : { server: SERVER, environment: { cwd: REMOTE_ROOT, home: '/home/ubuntu' } }
  const { service, remote, created } = harness(destination)
  await service.list({ sessionId: 'sess_remote', workspaceRoot: HOST_ROOT }, HOST_ROOT)
  await service.list({ sessionId: 'sess_remote', workspaceRoot: OTHER_HOST_ROOT }, OTHER_HOST_ROOT)
  assert.equal(created.length, 2)
  assert.deepEqual(created.map(request => request.environment.cwd), [REMOTE_ROOT, '/srv/other'])
  assert.deepEqual(remote.calls.filter(call => call[0] === 'resolve').map(call => call[1]), [REMOTE_ROOT, '/srv/other'])
})

test('a remote change feed answers workspace-file/watch-unsupported', async () => {
  const destination = () => ({ server: SERVER, environment: { cwd: REMOTE_ROOT, home: '/home/ubuntu' } })
  const { service, local, remote } = harness(destination)
  const signal = new AbortController().signal
  const stream = service.changes({ sessionId: 'sess_remote', workspaceRoot: HOST_ROOT }, HOST_ROOT, signal)

  await assert.rejects(async () => {
    for await (const item of stream) void item
  }, error => error.code === 'workspace-file/watch-unsupported')

  // The feed ran on the routed world: it resolved the remote root and target,
  // stat'ed the remote target, and never reached a local path or a local watch.
  assert.deepEqual(remote.calls, [
    ['resolve', REMOTE_ROOT, { signal }],
    ['resolve', REMOTE_ROOT, { signal }],
    ['stat', { targetKey: `remote:${REMOTE_ROOT}`, displayPath: REMOTE_ROOT }, signal],
  ])
  assert.equal(remote.calls.some(call => call[0] === 'watch'), false)
  assert.equal(local.calls.length, 0)
})

test('a world that cannot be built is reported and not cached', async () => {
  const failure = new Error('连接服务器失败')
  const { service, created } = harness(() => ({ server: SERVER, remotePath: REMOTE_ROOT }), {
    createWorld() {
      return Promise.reject(failure)
    },
  })
  const scope = { sessionId: 'sess_remote', workspaceRoot: HOST_ROOT }
  await assert.rejects(() => service.list(scope, HOST_ROOT), /连接服务器失败/)
  await assert.rejects(() => service.list(scope, HOST_ROOT), /连接服务器失败/)
  assert.equal(created.length, 2)
})

test('disposing the plugin restores every patched method', async () => {
  const { service, effects, handle, remote, created } = harness(() => ({ server: SERVER, environment: { cwd: REMOTE_ROOT, home: '/home/ubuntu' } }))
  assert.equal(Object.hasOwn(service, 'list'), true)
  assert.equal(typeof service[BRIDGE], 'object')
  assert.equal(effects.length, 1)
  await service.list({ sessionId: 'sess_remote', workspaceRoot: HOST_ROOT }, HOST_ROOT)
  assert.equal(handle.worlds.size, 1)

  await effects[0].cleanup()
  assert.equal(Object.hasOwn(service, 'list'), false)
  assert.equal(service.list, FakeService.prototype.list)
  assert.equal(service[BRIDGE], undefined)
  assert.equal(handle.worlds.size, 0)
  assert.equal(created.length, 1)
  assert.ok(remote.calls.length > 0)
})

test('installing twice patches the instance once', async () => {
  const destination = () => ({ server: SERVER, environment: { cwd: REMOTE_ROOT, home: '/home/ubuntu' } })
  const { service, effects, created, ctx } = harness(destination)
  installWorkspaceFilesBridge(ctx, {
    route: destination,
    createWorld: () => Promise.resolve({ fileSystem: recordingFs('second'), environment: { cwd: REMOTE_ROOT, home: '/home/ubuntu' } }),
    logger: ctx.logger,
  })
  assert.equal(effects.length, 1)
  await service.list({ sessionId: 'sess_remote', workspaceRoot: HOST_ROOT }, HOST_ROOT)
  assert.equal(created.length, 1)
})

test('the service is patched through the cordis traceable proxy', async () => {
  const local = recordingFs('local')
  const remote = recordingFs('remote')
  const service = new FakeService({ fs: local })
  const traceable = new Proxy(service, {
    get(target, property, receiver) {
      if (property === Symbol.for('cordis.original')) return target
      return Reflect.get(target, property, receiver)
    },
  })
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {} },
    inject: (names, callback) => callback({ workspaceFiles: traceable }),
    effect(factory, label) { effects.push({ label, cleanup: factory() }) },
  }
  installWorkspaceFilesBridge(ctx, {
    route: () => ({ server: SERVER, environment: { cwd: REMOTE_ROOT, home: '/home/ubuntu' } }),
    createWorld: () => Promise.resolve({ fileSystem: remote, environment: { cwd: REMOTE_ROOT, home: '/home/ubuntu' } }),
    logger: ctx.logger,
  })
  assert.equal(Object.hasOwn(service, 'list'), true)
  await traceable.list({ sessionId: 'sess_remote', workspaceRoot: HOST_ROOT }, HOST_ROOT)
  assert.equal(local.calls.length, 0)
  assert.deepEqual(remote.calls.map(call => call[0]), ['resolve', 'lstat', 'listDir'])
})

test('the bridge declines to install without a route, a world factory or the service', () => {
  const ctx = { inject: () => void 0, effect: () => void 0 }
  assert.equal(installWorkspaceFilesBridge({}, { route: () => void 0, createWorld: () => void 0 }), undefined)
  assert.equal(installWorkspaceFilesBridge(ctx, { createWorld: () => void 0 }), undefined)
  assert.equal(installWorkspaceFilesBridge(ctx, { route: () => void 0 }), undefined)

  const effects = []
  const empty = {
    logger: { info() {}, warn() {} },
    inject: (names, callback) => callback({}),
    effect(factory, label) { effects.push({ label, cleanup: factory() }) },
  }
  const handle = installWorkspaceFilesBridge(empty, { route: () => void 0, createWorld: () => void 0 })
  assert.equal(typeof handle.dispose, 'function')
  assert.equal(effects.length, 0)
})

test('a Host path is never mistaken for a remote path', () => {
  if (sep !== '\\') return
  assert.equal(isAbsolute('\\\\server\\share\\x'), true)
  assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, '\\\\server\\share\\x'), REMOTE_ROOT)
  assert.equal(translateWorkspacePath(HOST_ROOT, REMOTE_ROOT, 'D:\\other\\x.ts'), REMOTE_ROOT)
})
