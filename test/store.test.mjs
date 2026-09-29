import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RuntimeStore } from '../src/store.js'

const SERVER = { id: 'srv_store1', name: 'srv (ubuntu)', host: '10.0.0.1', port: 22, username: 'ubuntu', auth: { type: 'auto' }, remoteRoot: '~' }
const OTHER = { id: 'srv_store2', name: 'other', host: '10.0.0.2', port: 22, username: 'root', auth: { type: 'auto' }, remoteRoot: '/' }

async function tempBase() {
  return mkdtemp(join(tmpdir(), 'dshrs-store-'))
}

async function stateFileAt(base, state) {
  const file = join(base, '.dsh-remote-ssh', 'state.json')
  await mkdir(join(base, '.dsh-remote-ssh'), { recursive: true })
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return file
}

test('a version 8 state file migrates and keeps its remote directories', async () => {
  const base = await tempBase()
  try {
    const file = await stateFileAt(base, {
      version: 8,
      servers: [SERVER],
      selectedBySession: {},
      generationBySession: {},
      handoffsBySession: {},
      handoffContextAckBySession: {},
      folderWorkspaces: [
        { serverId: SERVER.id, remotePath: '/var/www/app', title: 'app', workspaceId: 'ws_app' },
        { serverId: 'srv_deleted', remotePath: '/srv/gone', title: 'gone' },
        { serverId: SERVER.id, remotePath: '/var/www/app', title: 'duplicate' },
      ],
    })
    const store = new RuntimeStore({ baseDir: base })
    await store.ready()
    assert.deepEqual(store.listFolderWorkspacesNow(), [
      { serverId: SERVER.id, remotePath: '/var/www/app', title: 'app', workspaceId: 'ws_app' },
    ])
    const persisted = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(persisted.version, 9, 'the migrated schema version is written back')
    assert.deepEqual(persisted.folderWorkspaces, [
      { serverId: SERVER.id, remotePath: '/var/www/app', title: 'app', workspaceId: 'ws_app' },
    ])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a remote directory is remembered once per server and path', async () => {
  const base = await tempBase()
  try {
    const store = new RuntimeStore({ baseDir: base })
    await store.upsertServer(SERVER)
    await store.upsertServer(OTHER)
    await store.upsertFolderWorkspace({ serverId: SERVER.id, remotePath: '/var/www/app', title: 'app', workspaceId: 'ws_app' })
    await store.upsertFolderWorkspace({ serverId: SERVER.id, remotePath: '/var/www/app', title: 'www/app', workspaceId: 'ws_app2' })
    await store.upsertFolderWorkspace({ serverId: OTHER.id, remotePath: '/var/www/app', title: 'app', workspaceId: 'ws_other' })
    assert.equal(store.listFolderWorkspacesNow().length, 2, 'the same path on two servers is two directories')
    assert.deepEqual(store.getFolderWorkspaceNow(SERVER.id, '/var/www/app'), {
      serverId: SERVER.id,
      remotePath: '/var/www/app',
      title: 'www/app',
      workspaceId: 'ws_app2',
    })
    assert.deepEqual(store.listFolderWorkspacesNow(SERVER.id).map(folder => folder.workspaceId), ['ws_app2'])
    assert.equal(store.getFolderWorkspaceNow(SERVER.id, '/srv/other'), undefined)

    const reloaded = new RuntimeStore({ baseDir: base })
    await reloaded.ready()
    assert.equal(reloaded.listFolderWorkspacesNow().length, 2, 'records survive a restart')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a remote directory needs an existing server and a path', async () => {
  const base = await tempBase()
  try {
    const store = new RuntimeStore({ baseDir: base })
    await store.upsertServer(SERVER)
    await assert.rejects(store.upsertFolderWorkspace({ serverId: 'srv_missing', remotePath: '/srv/x' }), /服务器不存在/u)
    await assert.rejects(store.upsertFolderWorkspace({ serverId: SERVER.id, remotePath: '  ' }), /required/u)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('forgetting a remote directory is reported', async () => {
  const base = await tempBase()
  try {
    const store = new RuntimeStore({ baseDir: base })
    await store.upsertServer(SERVER)
    await store.upsertFolderWorkspace({ serverId: SERVER.id, remotePath: '/srv/app', title: 'app' })
    assert.equal(await store.removeFolderWorkspace(SERVER.id, '/srv/app'), true)
    assert.equal(await store.removeFolderWorkspace(SERVER.id, '/srv/app'), false)
    assert.deepEqual(store.listFolderWorkspacesNow(), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('deleting a server takes its remote directories with it', async () => {
  const base = await tempBase()
  try {
    const store = new RuntimeStore({ baseDir: base })
    await store.upsertServer(SERVER)
    await store.upsertServer(OTHER)
    await store.upsertFolderWorkspace({ serverId: SERVER.id, remotePath: '/var/www/app', title: 'app' })
    await store.upsertFolderWorkspace({ serverId: SERVER.id, remotePath: '/var/www/api', title: 'api' })
    await store.upsertFolderWorkspace({ serverId: OTHER.id, remotePath: '/var/www/app', title: 'app' })

    assert.equal(store.listFolderWorkspacesNow(SERVER.id).length, 2)
    assert.deepEqual((await store.removeFolderWorkspacesOfServer(SERVER.id)).map(folder => folder.remotePath), ['/var/www/app', '/var/www/api'])
    assert.deepEqual(store.listFolderWorkspacesNow(), [
      { serverId: OTHER.id, remotePath: '/var/www/app', title: 'app' },
    ])

    await store.upsertFolderWorkspace({ serverId: SERVER.id, remotePath: '/var/www/app', title: 'app' })
    assert.equal(await store.removeServer(SERVER.id), true)
    assert.deepEqual(store.listFolderWorkspacesNow().map(folder => folder.serverId), [OTHER.id], 'removeServer drops its own directories')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
