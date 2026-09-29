import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  folderWorkspaceDir,
  folderWorkspaceSlug,
  folderWorkspaceTitle,
  locationForSessionCwd,
  remotePathKey,
  serverForSessionCwd,
  serverWorkspaceDir,
  serverWorkspaceTitle,
  syncFolderWorkspace,
  syncFolderWorkspaces,
  syncServerWorkspace,
  syncServerWorkspaces,
  uniqueFolderWorkspaceTitle,
  workspaceDirs,
} from '../src/server-workspace.js'

const SERVER = { id: 'srv_test1', name: 'srv (ubuntu)', username: 'ubuntu', host: '10.0.0.1', port: 22, remoteRoot: '~' }

async function tempBase() {
  return mkdtemp(join(tmpdir(), 'dshrs-ws-'))
}

function fakeRegistry(initial) {
  const calls = { create: [], resolve: [], titles: [] }
  let existing = initial
  return {
    calls,
    registry: {
      async resolveByPath(path) {
        calls.resolve.push(path)
        return existing
      },
      async create(path, title) {
        calls.create.push({ path, title })
        existing = { id: 'ws_new', path, title }
        return existing
      },
    },
    set existing(value) { existing = value },
  }
}

test('staging directory is derived from base dir and server id', () => {
  const dir = serverWorkspaceDir('C:\\state', 'srv_1')
  assert.equal(dir, join('C:\\state', 'remote-ssh-workspaces', 'srv_1'))
  assert.deepEqual(workspaceDirs('C:\\state', [SERVER]), { srv_test1: serverWorkspaceDir('C:\\state', 'srv_test1') })
  assert.equal(serverWorkspaceTitle(SERVER), 'srv (ubuntu)')
})

test('syncServerWorkspace creates the directory and registers it under the server name', async () => {
  const base = await tempBase()
  try {
    const fake = fakeRegistry(undefined)
    const workspace = await syncServerWorkspace({ workspaceRegistry: fake.registry }, base, SERVER)
    const dir = serverWorkspaceDir(base, SERVER.id)
    assert.equal((await stat(dir)).isDirectory(), true, 'staging directory must exist before registration')
    assert.equal(workspace.path, dir)
    assert.deepEqual(fake.calls.create, [{ path: dir, title: 'srv (ubuntu)' }])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('syncServerWorkspace reuses an existing registration and retitles on rename', async () => {
  const base = await tempBase()
  try {
    const dir = serverWorkspaceDir(base, SERVER.id)
    const existing = {
      id: 'ws_existing',
      path: dir,
      title: 'old name',
      async setTitle(title) { this.title = title },
    }
    const fake = fakeRegistry(existing)
    const workspace = await syncServerWorkspace({ workspaceRegistry: fake.registry }, base, SERVER)
    assert.equal(workspace.id, 'ws_existing')
    assert.equal(workspace.title, 'srv (ubuntu)')
    assert.equal(fake.calls.create.length, 0, 'an existing registration is never re-created')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('syncServerWorkspace degrades when the deployment mounts no workspace registry', async () => {
  const base = await tempBase()
  try {
    assert.equal(await syncServerWorkspace({}, base, SERVER), undefined)
    assert.equal(await syncServerWorkspace({ workspaceRegistry: {} }, base, SERVER), undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('syncServerWorkspaces isolates a failing server', async () => {
  const base = await tempBase()
  try {
    const warnings = []
    const ctx = {
      workspaceRegistry: {
        async resolveByPath() { return undefined },
        async create(path, title) {
          if (title === 'bad') throw new Error('registry rejected the directory')
          return { id: `ws_${title}`, path, title }
        },
      },
    }
    const created = await syncServerWorkspaces(ctx, base, [SERVER, { id: 'srv_bad', name: 'bad' }], { warn: message => warnings.push(message) })
    assert.deepEqual(created, [{ serverId: SERVER.id, workspaceId: 'ws_srv (ubuntu)' }])
    assert.equal(warnings.length, 1)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('serverForSessionCwd maps a session cwd back to its server workspace', async () => {
  const base = await tempBase()
  try {
    const dir = serverWorkspaceDir(base, SERVER.id)
    const servers = [SERVER, { id: 'srv_other', name: 'other' }]
    assert.equal(serverForSessionCwd(base, servers, dir)?.id, SERVER.id)
    assert.equal(serverForSessionCwd(base, servers, `${dir}\\`)?.id, SERVER.id, 'trailing separators are ignored')
    assert.equal(serverForSessionCwd(base, servers, resolve(dir).toUpperCase())?.id, SERVER.id, 'case differences are ignored')
    assert.equal(serverForSessionCwd(base, servers, join(base, 'some-local-project')), undefined)
    assert.equal(serverForSessionCwd(base, servers, undefined), undefined)
    assert.equal(serverForSessionCwd(base, [], dir), undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// The slug is a durable on-disk identity: changing the hash would orphan every
// already-registered remote directory, so the exact value is pinned here.
test('remote directory slug is stable, collision free and safe as a path segment', () => {
  assert.equal(remotePathKey('/var/www/app'), '1eb37e2b')
  assert.equal(folderWorkspaceSlug('/var/www/app'), 'app-1eb37e2b')
  assert.equal(folderWorkspaceSlug('/var/www/app'), folderWorkspaceSlug('/var/www/app'), 'same path, same directory')
  assert.notEqual(folderWorkspaceSlug('/var/www/app'), folderWorkspaceSlug('/opt/app'), 'same basename must not collide')
  assert.equal(folderWorkspaceSlug('/srv/a:b<c>d|e?f*g').startsWith('a_b_c_d_e_f_g-'), true, 'reserved characters are replaced, not dropped')
  assert.equal(/[<>:"/\\|?*]/u.test(folderWorkspaceSlug('/srv/a:b<c>d|e?f*g')), false)
  assert.equal(folderWorkspaceSlug('/home/ubuntu/'), folderWorkspaceSlug('/home/ubuntu'), 'one remote directory is one staging directory, however it is spelled')
  assert.equal(folderWorkspaceSlug('/home/ubuntu/'), 'ubuntu-3b2485e5')
  assert.equal(folderWorkspaceSlug('/'), 'dir-2a0c975e', 'the filesystem root still yields a usable segment')
  assert.equal(folderWorkspaceSlug(''), '_-2b0c98f1', 'even an empty spelling yields a usable segment')
  assert.equal(folderWorkspaceTitle('/var/www/app'), 'app')
})

test('a remote directory staging directory nests inside its server staging directory', async () => {
  const base = await tempBase()
  try {
    const serverDir = serverWorkspaceDir(base, SERVER.id)
    const dir = folderWorkspaceDir(base, SERVER.id, '/var/www/app')
    assert.equal(dir, join(serverDir, 'app-1eb37e2b'))
    assert.equal(dir.startsWith(`${serverDir}\\`) || dir.startsWith(`${serverDir}/`), true,
      'DSH groups child workspaces by path containment, so the child directory must live under the server directory')
    assert.equal(folderWorkspaceDir(base, 'srv_other', '/var/www/app'), join(serverWorkspaceDir(base, 'srv_other'), 'app-1eb37e2b'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('remote directory titles stay unique inside one server', () => {
  assert.equal(uniqueFolderWorkspaceTitle('/var/www/app', []), 'app')
  assert.equal(uniqueFolderWorkspaceTitle('/var/www/app', ['other']), 'app')
  assert.equal(uniqueFolderWorkspaceTitle('/var/www/app', new Set(['app'])), 'www/app', 'a taken name is qualified by its parent')
  assert.equal(uniqueFolderWorkspaceTitle('/var/www/app', ['app', 'www/app']), 'www/app (2)', 'a qualified name that is taken too gets a suffix')
  assert.equal(uniqueFolderWorkspaceTitle('/var/www/app', ['app', 'www/app', 'www/app (2)']), 'www/app (3)')
  assert.equal(uniqueFolderWorkspaceTitle('/', []), '/', 'the filesystem root has no name to borrow')
})

test('syncFolderWorkspace creates the child directory and registers it under the directory name', async () => {
  const base = await tempBase()
  try {
    const fake = fakeRegistry(undefined)
    const workspace = await syncFolderWorkspace({ workspaceRegistry: fake.registry }, base, SERVER, '/var/www/app')
    const dir = folderWorkspaceDir(base, SERVER.id, '/var/www/app')
    assert.equal((await stat(dir)).isDirectory(), true)
    assert.deepEqual(fake.calls.create, [{ path: dir, title: 'app' }])

    const renamed = fakeRegistry(undefined)
    await syncFolderWorkspace({ workspaceRegistry: renamed.registry }, base, SERVER, '/var/www/app', { title: 'www/app' })
    assert.deepEqual(renamed.calls.create, [{ path: dir, title: 'www/app' }], 'an explicit title wins over the directory name')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('syncFolderWorkspace degrades without a registry and ignores an incomplete record', async () => {
  const base = await tempBase()
  try {
    assert.equal(await syncFolderWorkspace({}, base, SERVER, '/var/www/app'), undefined)
    assert.equal(await syncFolderWorkspace({ workspaceRegistry: {} }, base, SERVER, '/var/www/app'), undefined)
    assert.equal(await syncFolderWorkspace({}, base, SERVER, ''), undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('syncFolderWorkspaces skips directories whose server is gone and isolates failures', async () => {
  const base = await tempBase()
  try {
    const warnings = []
    const ctx = {
      workspaceRegistry: {
        async resolveByPath() { return undefined },
        async create(path, title) {
          if (title === 'bad') throw new Error('registry rejected the directory')
          return { id: `ws_${title}`, path, title }
        },
      },
    }
    const created = await syncFolderWorkspaces(ctx, base, [SERVER], [
      { serverId: SERVER.id, remotePath: '/var/www/app', title: 'app' },
      { serverId: 'srv_deleted', remotePath: '/srv/gone', title: 'gone' },
      { serverId: SERVER.id, remotePath: '/srv/bad', title: 'bad' },
    ], { warn: message => warnings.push(message) })
    assert.deepEqual(created, [{ serverId: SERVER.id, remotePath: '/var/www/app', title: 'app', workspaceId: 'ws_app' }])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].startsWith('DSH Remote SSH folder workspace'), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('locationForSessionCwd resolves a child directory before its server', async () => {
  const base = await tempBase()
  try {
    const servers = [SERVER]
    const folders = [{ serverId: SERVER.id, remotePath: '/var/www/app', title: 'app' }]
    const child = folderWorkspaceDir(base, SERVER.id, '/var/www/app')
    assert.deepEqual(locationForSessionCwd(base, servers, folders, child), { server: SERVER, remotePath: '/var/www/app' })
    assert.deepEqual(locationForSessionCwd(base, servers, folders, `${child}\\`), { server: SERVER, remotePath: '/var/www/app' })
    assert.equal(locationForSessionCwd(base, servers, folders, join(child, 'src')), undefined,
      'only a workspace directory identifies a location; a Host path nested inside the staging tree means nothing on the remote side')
    assert.deepEqual(locationForSessionCwd(base, servers, folders, serverWorkspaceDir(base, SERVER.id)), { server: SERVER })
    assert.equal(locationForSessionCwd(base, servers, folders, join(base, 'local-project')), undefined)
    assert.equal(locationForSessionCwd(base, servers, folders, undefined), undefined)
    assert.deepEqual(locationForSessionCwd(base, servers, [{ serverId: 'srv_deleted', remotePath: '/srv/gone' }], folderWorkspaceDir(base, 'srv_deleted', '/srv/gone')), undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
