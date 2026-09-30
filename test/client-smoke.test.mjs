// Smoke tests for the shipped client bundle.
//
// `client.js` is the file the browser actually loads (`window.__ModuleLoader__.load`),
// so `node --check` only proves it parses. These tests evaluate the real bundle with a
// minimal React/primitives stub, run `apply(ctx)` against a fake slot host, resolve the
// injected props of every registered entry, render the remote-workspaces entry one level
// deep, and then *drive its buttons* through a stubbed `fetch` and a fake workspace
// mirror. That is what catches module-eval breakage, registration drift, undefined
// helpers, and the mirror-probe/remove-tombstone regressions a syntax check cannot see.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const clientPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const SERVER = { id: 'srv_1', name: 'srv (ubuntu)', username: 'ubuntu', host: '10.0.0.2', port: 22 }

// A minimal hook runtime: state is keyed by component identity + hook position and
// survives across `render()` calls, so a test can click a button and then assert the
// next render. The very first `useState` of the first component entered after
// `reset()` is forced to `true`, which is how the entry's dialog gets rendered at all
// (its `useState(false)` is the open flag).
function makeReact({ runEffects = false } = {}) {
  const hooks = new Map()
  let component = null
  let slot = 0
  let forced = true
  const key = () => `${component}#${slot++}`
  return {
    reset: () => { forced = true },
    enter: type => { component = type?.name || 'anonymous'; slot = 0 },
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}), children: children.length > 1 ? children : children[0] },
    }),
    useState: value => {
      const k = key()
      if (forced) { forced = false; hooks.set(k, true); return [true, () => {}] }
      if (!hooks.has(k)) hooks.set(k, typeof value === 'function' ? value() : value)
      return [hooks.get(k), next => { hooks.set(k, typeof next === 'function' ? next(hooks.get(k)) : next) }]
    },
    useMemo: factory => factory(),
    useEffect: effect => { if (runEffects) effect() },
    useRef: value => ({ current: value }),
    useCallback: fn => fn,
  }
}

function makePrimitives() {
  return new Proxy({}, {
    get: (_target, name) => (name === 'writeClipboard' ? async () => {} : props => ({ type: `primitive:${String(name)}`, props })),
  })
}

/** Evaluate the bundle and drive `apply` against a fake slot host. */
function loadPlugin({ services = {}, throwing = false, runEffects = false } = {}) {
  const source = readFileSync(clientPath, 'utf8')
  const loaded = {}
  const react = makeReact({ runEffects })
  const windowStub = {
    __ModuleLoader__: { load: options => { loaded.options = options } },
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => true,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  }
  const require = name => (name === 'react' ? react : makePrimitives())
  new Function('window', 'require', source)(windowStub, require)
  assert.ok(loaded.options, 'client.js must call window.__ModuleLoader__.load')
  assert.equal(loaded.options.id, 'dsh-remote-ssh')
  const plugin = loaded.options.factory(require)
  assert.equal(plugin.name, 'dsh-remote-ssh-client')
  assert.ok(Array.isArray(plugin.inject))
  const entries = []
  const ctx = {
    slots: {
      inject: (_slot, factory) => factory(),
      register: (options, component) => { entries.push({ slot: options.name, options, component }); return () => {} },
    },
    uiConversation: { events: { register: () => {} } },
    get: name => {
      if (throwing) throw new Error('facade denied')
      return services[name]
    },
    effect: () => {},
    on: () => {},
    once: () => {},
  }
  plugin.apply(ctx)
  return { plugin, entries, react }
}

/** Render function components depth-first, so a test can click real handlers. */
function expand(node, env) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    env.react.enter(node.type)
    return expand(node.type({ ...env, ...node.props }), env)
  }
  const kids = node.props?.children
  // React flattens a mapped array into the surrounding children; without that, a
  // `rows.map(...)` child stays a nested array and `findButton`/`texts` cannot
  // reach the rows it rendered.
  const rendered = (Array.isArray(kids) ? kids.flat(Infinity) : [kids]).map(child => expand(child, env))
  return { ...node, props: { ...node.props, children: Array.isArray(kids) ? rendered : rendered[0] } }
}

function texts(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out }
  if (!node || typeof node !== 'object') return out
  const kids = node.props?.children
  for (const child of Array.isArray(kids) ? kids : [kids]) texts(child, out)
  return out
}

function findButton(node, label) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button' && texts(node).includes(label)) return node
  const kids = node.props?.children
  for (const child of Array.isArray(kids) ? kids : [kids]) {
    const found = findButton(child, label)
    if (found) return found
  }
  return null
}

/**
 * Depth-first search over a rendered tree, following *every* object-valued prop.
 * DSH primitives receive nodes outside `children` (`Menu` takes its trigger as
 * `anchor`), so a children-only walk cannot reach a real control.
 */
function findInTree(root, predicate) {
  const seen = new Set()
  const visit = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return null
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) { const found = visit(item); if (found) return found }
      return null
    }
    if (value.type !== undefined && value.props !== undefined && predicate(value)) return value
    for (const [key, child] of Object.entries(value)) {
      if (key === 'react') continue
      const found = visit(child)
      if (found) return found
    }
    return null
  }
  return visit(root)
}

/** The row's own location trigger. */
function findTrigger(root) {
  return findInTree(root, node => typeof node.props?.className === 'string' && node.props.className.includes('dshrs-row-action'))
}

/**
 * First clickable node whose text contains `label`. DSH primitives render as
 * function components here, so a label-driven search is the only way to reach a
 * Button that is not a native `<button>`.
 */
function findClickableByText(root, label) {
  const match = findInTree(root, node => typeof node.props?.onClick === 'function' && texts(node).some(text => String(text).includes(label)))
  return match
}

/** The dialog body of the remote-workspaces entry, rendered with real handlers. */
function renderDialog({ services = {}, runEffects = false } = {}) {
  const { entries, react } = loadPlugin({ services, runEffects })
  const entry = entries.find(item => item.options?.id === 'dsh-remote-ssh:remote-workspaces')
  const props = entry.options.inject()
  const render = () => expand(entry.component({ ...props, wide: true }), { react })
  return { entries, react, render }
}

/** Install the browser globals the bundle touches, and always restore them. */
async function withGlobals({ fetch, tickMs = 0 }, body) {
  const saved = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout, document: globalThis.document }
  const realSetTimeout = globalThis.setTimeout
  globalThis.fetch = fetch
  globalThis.setInterval = () => 0
  if (tickMs) globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms || 0, tickMs))
  globalThis.document = { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild: () => {} } }
  try {
    return await body()
  } finally {
    globalThis.fetch = saved.fetch
    globalThis.setInterval = saved.setInterval
    globalThis.setTimeout = saved.setTimeout
    globalThis.document = saved.document
  }
}

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

/** Poll a predicate against the real event loop instead of guessing a delay. */
async function settle(predicate, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick()
  }
  return predicate()
}

function json(value) {
  return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
}

test('the client bundle evaluates and registers the sidebar entries', () => {
  const { entries } = loadPlugin()
  const ids = entries.map(entry => entry.options?.id ?? entry.slot)
  assert.ok(ids.includes('dsh-remote-ssh:remote-workspaces'), `server-workspace entry missing from ${ids.join(', ')}`)
  assert.ok(ids.includes('dsh-remote-ssh:execution-location'))
  assert.ok(entries.some(entry => entry.slot === 'conversation.chat.node'))
  const entry = entries.find(item => item.options?.id === 'dsh-remote-ssh:remote-workspaces')
  assert.equal(entry.slot, 'sidebar.footer.action')
  assert.equal(entry.options.order, 41)
  assert.equal(typeof entry.options.label, 'function')
  assert.equal(entry.options.label(), '服务器工作区')
  assert.equal(typeof entry.options.inject, 'function')

  // The workspace column's foot holds exactly one entry from this plugin: the panel
  // owns server management now, and a second foot control listing the same servers as
  // "execution locations" was the thing that made the foot redundant.
  const foot = entries.filter(item => item.slot === 'sidebar.footer.action')
  assert.deepEqual(foot.map(item => item.options.id), ['dsh-remote-ssh:remote-workspaces'])
  const location = entries.find(item => item.options?.id === 'dsh-remote-ssh:execution-location')
  assert.equal(location.slot, 'sidebar.workspaces.session.row.action')
})

test('the injected props resolve services lazily, and never throw on a closed facade', () => {
  const uiWorkspace = { openWorkspace: async () => {} }
  const workspaces = { list: { getSnapshot: () => ({ items: [] }) } }
  const open = loadPlugin({ services: { uiWorkspace, workspaces } })
  const props = open.entries.find(item => item.options?.id === 'dsh-remote-ssh:remote-workspaces').options.inject()
  assert.equal(typeof props.rpc, 'function')
  assert.equal(props.resolveUiWorkspace(), uiWorkspace)
  assert.equal(props.resolveWorkspaces(), workspaces)

  // A facade that throws on every lookup (an undeclared read on the real client
  // proxy) must degrade to `undefined`, never raise out of the resolver.
  const closed = loadPlugin({ throwing: true })
  const closedProps = closed.entries.find(item => item.options?.id === 'dsh-remote-ssh:remote-workspaces').options.inject()
  assert.equal(closedProps.resolveUiWorkspace(), undefined)
  assert.equal(closedProps.resolveWorkspaces(), undefined)
})

test('the entry renders its trigger and the empty dialog without a workspace service', () => {
  const { render } = renderDialog()
  const tree = render()
  const strings = texts(tree)
  assert.ok(strings.includes('服务器工作区'), `trigger/dialog text missing: ${strings.join(' | ')}`)
  assert.ok(strings.includes('还没有服务器'), `empty state missing: ${strings.join(' | ')}`)
  assert.ok(JSON.stringify(tree).includes('把服务器或服务器里的目录加为工作区'))
})

test('adding a server waits for the client workspace mirror and opens it exactly once', async () => {
  const calls = []
  let snapshots = 0
  let opened = 0
  let failedOpens = 0
  let overviewCallsAtOpen = -1
  // The mirror only publishes the new record after a few reads, and the real
  // `uiWorkspace.openWorkspace` reads that mirror before navigating: opened too early it
  // shows DSH's "新建会话失败" toast and rejects. Reproducing that read is what makes this
  // test fail if the probe loop ever goes away.
  const uiWorkspace = {
    openWorkspace: async () => {
      opened += 1
      if (snapshots <= 3) { failedOpens += 1; throw new Error('新建会话失败：unknown workspace ws_new') }
      overviewCallsAtOpen = calls.filter(call => call.method === 'overview').length
    },
  }
  const workspaces = { list: { getSnapshot: () => { snapshots += 1; return { items: snapshots > 3 ? [{ workspaceId: 'ws_new' }] : [] } } } }
  const fetchStub = async (url, options) => {
    const method = String(url).slice(String(url).lastIndexOf('/') + 1)
    calls.push({ method, payload: JSON.parse(options.body).payload })
    if (method === 'overview') return json({ servers: [SERVER], connections: { [SERVER.id]: { state: 'connected' } }, workspaceDirs: { [SERVER.id]: 'C:\\stage\\srv_1' } })
    if (method === 'workspace.addServer') return json({ serverId: SERVER.id, workspaceId: 'ws_new', title: SERVER.name, dir: 'C:\\stage\\srv_1' })
    throw new Error(`unexpected rpc ${method}`)
  }
  await withGlobals({ fetch: fetchStub, tickMs: 2 }, async () => {
    const { render, react } = renderDialog({ services: { uiWorkspace, workspaces }, runEffects: true })
    // The dialog only lists servers once the overview effect has published a snapshot,
    // so re-render until the Host's answer has landed.
    let button = null
    assert.ok(await settle(() => { react.reset(); button = findButton(render(), '加为工作区'); return Boolean(button) }), 'the dialog must list the server with an add button')
    assert.equal(button.props.disabled, false)
    await tick(30) // let an in-flight overview land, so each refresh below issues two requests
    const overviewsBeforeOpen = calls.filter(call => call.method === 'overview').length
    button.props.onClick()
    assert.ok(await settle(() => opened > 0), 'the workspace must be opened')
    assert.equal(calls[0].method, 'overview')
    assert.equal(calls.find(call => call.method === 'workspace.addServer').payload.serverId, SERVER.id)
    assert.equal(opened, 1, 'openWorkspace toasts a failure before it throws, so it must be called once')
    assert.equal(failedOpens, 0, 'the mirror must be ready before the single open, or DSH toasts a failure')
    assert.ok(snapshots > 1, `the probe must poll the mirror before opening (reads: ${snapshots})`)
    assert.ok(overviewCallsAtOpen - overviewsBeforeOpen >= 4, `the probe must refresh the overview after every read (refresh calls: ${overviewCallsAtOpen - overviewsBeforeOpen})`)
  })
})

test('adding a server still refreshes before opening when the mirror service is absent', async () => {
  const calls = []
  let opened = 0
  let overviewCallsAtOpen = -1
  const uiWorkspace = { openWorkspace: async () => { opened += 1; overviewCallsAtOpen = calls.filter(call => call.method === 'overview').length } }
  const fetchStub = async (url, options) => {
    const method = String(url).slice(String(url).lastIndexOf('/') + 1)
    calls.push({ method, payload: JSON.parse(options.body).payload })
    if (method === 'overview') return json({ servers: [SERVER], connections: {}, workspaceDirs: {} })
    if (method === 'workspace.addServer') return json({ serverId: SERVER.id, workspaceId: 'ws_new', title: SERVER.name, dir: 'C:\\stage\\srv_1' })
    throw new Error(`unexpected rpc ${method}`)
  }
  await withGlobals({ fetch: fetchStub, tickMs: 2 }, async () => {
    // No `workspaces` service at all: the mirror cannot be polled, so the flow has to
    // fall back to refreshing the plugin's own overview before its single attempt.
    const { render, react } = renderDialog({ services: { uiWorkspace }, runEffects: true })
    let button = null
    assert.ok(await settle(() => { react.reset(); button = findButton(render(), '加为工作区'); return Boolean(button) }), 'the dialog must list the server with an add button')
    await tick(30) // let an in-flight overview land, so each refresh below issues two requests
    const overviewsBeforeOpen = calls.filter(call => call.method === 'overview').length
    button.props.onClick()
    assert.ok(await settle(() => opened > 0), 'the workspace must be opened')
    assert.equal(opened, 1)
    // `addServer` already refreshes once; the absent-mirror branch adds a second refresh
    // plus a short wait, which is the whole point of the branch.
    assert.ok(overviewCallsAtOpen - overviewsBeforeOpen >= 4, `the absent-mirror path must refresh twice before its single open (refresh calls: ${overviewCallsAtOpen - overviewsBeforeOpen})`)
  })
})

test('the panel adds a server itself, inside the dialog', async () => {
  const calls = []
  const fetchStub = async (url, options) => {
    const method = String(url).slice(String(url).lastIndexOf('/') + 1)
    calls.push({ method, payload: JSON.parse(options.body).payload })
    if (method === 'overview') return json({ servers: [], connections: {}, workspaceDirs: {}, hostPlatform: 'win32' })
    if (method === 'server.testAndSave') return json({ server: { ...SERVER }, fingerprint: 'SHA256:x' })
    throw new Error(`unexpected rpc ${method}`)
  }
  await withGlobals({ fetch: fetchStub, tickMs: 2 }, async () => {
    const { render, react } = renderDialog({ runEffects: true })
    let add = null
    assert.ok(await settle(() => { react.reset(); add = findButton(render(), '添加服务器'); return Boolean(add) }), 'the empty panel must offer 添加服务器')
    const empty = (react.reset(), render())
    assert.ok(texts(empty).includes('还没有服务器'))
    assert.ok(!texts(empty).includes('测试并保存'), 'the form must not be open before the button is pressed')
    add.props.onClick()
    const form = (react.reset(), render())
    const strings = texts(form)
    assert.ok(strings.includes('添加服务器工作区'), 'the server form must open as a view of this dialog')
    // The save action goes through the DSH Button primitive, so it is asserted by
    // text rather than via `findButton`, which only returns native `<button>`s.
    assert.ok(strings.includes('测试并保存'), 'the form must offer its save action')
    assert.ok(findButton(form, '‹ 返回'), 'the form must offer a way back to the list')
  })
})

test('the panel manages an existing server in place', async () => {
  const fetchStub = async url => {
    const method = String(url).slice(String(url).lastIndexOf('/') + 1)
    if (method === 'overview') return json({ servers: [SERVER], connections: {}, workspaceDirs: { [SERVER.id]: 'C:\\stage\\srv_1' } })
    throw new Error(`unexpected rpc ${method}`)
  }
  await withGlobals({ fetch: fetchStub, tickMs: 2 }, async () => {
    const { render, react } = renderDialog({ runEffects: true })
    let manage = null
    assert.ok(await settle(() => { react.reset(); manage = findButton(render(), '管理服务器'); return Boolean(manage) }), 'the panel must offer 管理服务器 once a server exists')
    manage.props.onClick()
    const tree = (react.reset(), render())
    assert.ok(texts(tree).includes('管理服务器'))
    assert.ok(findButton(tree, '重连'), 'the management view must offer 重连')
    assert.ok(findButton(tree, '编辑'))
    assert.ok(findButton(tree, '删除'))
    assert.ok(findButton(tree, '‹ 返回'))
  })
})

test('the row action switches exactly the Session it is rendered on', async () => {
  const calls = []
  const fetchStub = async (url, options) => {
    const method = String(url).slice(String(url).lastIndexOf('/') + 1)
    const payload = JSON.parse(options.body).payload
    calls.push({ method, payload })
    if (method === 'overview') return json({ servers: [SERVER], connections: { [SERVER.id]: { state: 'connected' } }, workspaceDirs: {} })
    if (method === 'state') return json({ servers: [SERVER], connections: { [SERVER.id]: { state: 'connected' } }, target: { type: 'local' }, busy: false })
    if (method === 'target.set') return json({ servers: [SERVER], connections: {}, target: payload.target, busy: false })
    throw new Error(`unexpected rpc ${method}`)
  }
  await withGlobals({ fetch: fetchStub, tickMs: 2 }, async () => {
    const { entries, react } = loadPlugin({ runEffects: true })
    const entry = entries.find(item => item.options?.id === 'dsh-remote-ssh:execution-location')
    // The row hands the control its Session id, and that is the whole contract: the
    // control used to be reachable without one, from the workspace column's foot.
    const render = () => {
      react.reset()
      return expand(entry.component({ ...entry.options.inject(), sessionId: 'sess_1' }), { react })
    }
    let tree = render()
    assert.ok(JSON.stringify(tree).includes('dshrs-row-action'), 'the row must render the location trigger')
    assert.ok(!texts(tree).includes('执行位置（先打开一个对话）'), 'the no-Session mode must be gone')
    let serverRow = null
    assert.ok(await settle(() => { tree = render(); serverRow = findButton(tree, SERVER.name); return Boolean(serverRow) }), 'the row menu must list the Servers from the overview snapshot')
    assert.equal(serverRow.props.disabled, false, 'a switchable row menu must not render its options disabled')
    serverRow.props.onClick()
    assert.ok(await settle(() => calls.some(call => call.method === 'target.set')), 'choosing a Server must go through target.set')
    const switchCall = calls.find(call => call.method === 'target.set')
    assert.deepEqual(switchCall.payload, { sessionId: 'sess_1', target: { type: 'ssh', serverId: SERVER.id } })
  })
})

test('saving a Server from a Session row never moves that Session', async () => {
  // The row menu embeds the Server editor, so a save *tests and saves* a Server; it
  // must not double as "switch this conversation". Editing an already saved Server
  // used to re-apply `target.set` for the row's Session on every save, which silently
  // undid a user's explicit "本地电脑" choice for a conversation sitting in a local
  // Workspace.
  const calls = []
  const fetchStub = async (url, options) => {
    const method = String(url).slice(String(url).lastIndexOf('/') + 1)
    const payload = JSON.parse(options.body).payload
    calls.push({ method, payload })
    if (method === 'overview') return json({ servers: [SERVER], connections: {}, workspaceDirs: {} })
    if (method === 'state') return json({ servers: [SERVER], connections: {}, target: { type: 'local' }, busy: false })
    if (method === 'server.testAndSave') return json({ server: { ...SERVER }, fingerprint: 'SHA256:x' })
    if (method === 'target.set') return json({ servers: [SERVER], connections: {}, target: payload.target, busy: false })
    throw new Error(`unexpected rpc ${method}`)
  }
  await withGlobals({ fetch: fetchStub, tickMs: 2 }, async () => {
    const { entries, react } = loadPlugin({ runEffects: true })
    const entry = entries.find(item => item.options?.id === 'dsh-remote-ssh:execution-location')
    const render = () => {
      react.reset()
      return expand(entry.component({ ...entry.options.inject(), sessionId: 'sess_1' }), { react })
    }
    let trigger = null
    assert.ok(await settle(() => { trigger = findTrigger(render()); return Boolean(trigger) }), 'the row must render its location trigger')
    trigger.props.onClick()
    let manage = null
    assert.ok(await settle(() => { manage = findButton(render(), '管理服务器'); return Boolean(manage) }), 'the row menu must offer 管理服务器')
    manage.props.onClick()
    let edit = null
    assert.ok(await settle(() => { edit = findButton(render(), '编辑'); return Boolean(edit) }), 'the management view must offer 编辑')
    edit.props.onClick()
    let save = null
    assert.ok(await settle(() => { save = findClickableByText(render(), '测试并保存'); return Boolean(save) }), 'the editor must offer its save action')
    save.props.onClick()
    assert.ok(await settle(() => calls.some(call => call.method === 'server.testAndSave')), 'saving must go through server.testAndSave')
    // `testAndSave` keeps working=true until every follow-up RPC has settled, so the
    // label coming back is the signal that the whole save flow (including any switch
    // the client used to append) is finished.
    assert.ok(await settle(() => !texts(render()).includes('正在测试并保存…')), 'the save flow must settle')
    assert.deepEqual(calls.filter(call => call.method === 'target.set'), [], 'saving a Server must not change where this Session executes')
  })
})
