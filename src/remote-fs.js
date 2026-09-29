import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { TextDecoder } from 'node:util'
import { FileSystem, FsError } from '@deepseek-ai/dsh-fs'
import { normalizeRemotePath, parseRemoteTargetKey, remoteTargetKey } from './utils.js'

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

function fsError(error, verb, path) {
  if (error instanceof FsError) return error
  const code = error?.code
  if (code === 2 || code === 'ENOENT') return new FsError(`cannot ${verb} "${path}": not found`, 'FS_NOT_FOUND', { cause: error })
  if (code === 3 || code === 'EACCES' || code === 'EPERM') return new FsError(`cannot ${verb} "${path}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  return new FsError(`cannot ${verb} "${path}": ${error?.message || String(error)}`, 'FS_IO_ERROR', { cause: error })
}

function typeFromMode(mode, lstat = false) {
  const kind = Number(mode || 0) & S_IFMT
  if (kind === S_IFREG) return 'file'
  if (kind === S_IFDIR) return 'directory'
  if (lstat && kind === S_IFLNK) return 'symlink'
  return 'other'
}

function versionFromAttrs(attrs) {
  return `sshfs:${attrs?.size || 0}:${attrs?.mtime || 0}:${attrs?.mode || 0}:${attrs?.uid || 0}:${attrs?.gid || 0}`
}

function metadata(attrs, lstat = false) {
  const type = typeFromMode(attrs?.mode, lstat)
  return {
    version: versionFromAttrs(attrs),
    type,
    ...(type === 'file' ? { size: Number(attrs?.size || 0) } : {}),
  }
}

function callSftp(sftp, method, ...args) {
  return new Promise((resolve, reject) => sftp[method](...args, (error, value, extra) => error ? reject(error) : resolve(extra === undefined ? value : [value, extra])))
}

function targetParts(target, expectedServerId) {
  const parsed = parseRemoteTargetKey(target?.targetKey)
  if (!parsed || (expectedServerId && parsed.serverId !== expectedServerId)) {
    throw new FsError('invalid remote filesystem target', 'FS_IO_ERROR')
  }
  return parsed
}

async function readAll(sftp, path, maxBytes = Infinity, signal) {
  const attrs = await callSftp(sftp, 'stat', path).catch(error => { throw fsError(error, 'read', path) })
  if (typeFromMode(attrs.mode) !== 'file') throw new FsError(`cannot read "${path}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  if (Number(attrs.size) > maxBytes) throw new FsError(`cannot read "${path}": file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
  const stream = sftp.createReadStream(path)
  const chunks = []
  let total = 0
  return await new Promise((resolve, reject) => {
    const abort = () => stream.destroy(new Error('aborted'))
    if (signal) {
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    stream.on('data', chunk => {
      total += chunk.length
      if (total > maxBytes) {
        stream.destroy(new FsError(`cannot read "${path}": file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE'))
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    stream.on('error', error => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new FsError('read aborted', 'FS_ABORTED'))
      else reject(error instanceof FsError ? error : fsError(error, 'read', path))
    })
    stream.on('end', () => {
      signal?.removeEventListener('abort', abort)
      resolve(Buffer.concat(chunks))
    })
  })
}

/**
 * Read one byte window of a regular file.
 *
 * A window is bounded by the caller, so unlike `readAll` it has no maximum to
 * enforce: at most `length` bytes are transferred, plus the skipped prefix the
 * SFTP server reads to reach the offset.
 *
 * @param sftp - the SFTP session.
 * @param path - absolute remote path.
 * @param offset - first byte of the window.
 * @param length - window length in bytes.
 * @param signal - caller cancellation.
 * @returns the window, shorter than `length` at end of file.
 */
async function readRange(sftp, path, offset, length, signal) {
  const attrs = await callSftp(sftp, 'stat', path).catch(error => { throw fsError(error, 'read', path) })
  if (typeFromMode(attrs.mode) !== 'file') throw new FsError(`cannot read "${path}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  const size = Number(attrs.size || 0)
  if (!(length > 0) || !(offset < size)) return Buffer.alloc(0)
  const stream = sftp.createReadStream(path, { start: offset, end: Math.min(size, offset + length) - 1 })
  const chunks = []
  return await new Promise((resolve, reject) => {
    const abort = () => stream.destroy(new Error('aborted'))
    if (signal) {
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    stream.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
    stream.on('error', error => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new FsError('read aborted', 'FS_ABORTED'))
      else reject(error instanceof FsError ? error : fsError(error, 'read', path))
    })
    stream.on('end', () => {
      signal?.removeEventListener('abort', abort)
      resolve(Buffer.concat(chunks))
    })
  })
}

function decodeUtf8(bytes, path) {
  if (bytes.subarray(0, 8192).includes(0)) throw new FsError(`cannot read "${path}": binary file`, 'FS_NOT_TEXT')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch (error) { throw new FsError(`cannot read "${path}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error }) }
}

async function existsAttrs(sftp, path, lstat = false) {
  try { return await callSftp(sftp, lstat ? 'lstat' : 'stat', path) }
  catch (error) {
    if (error?.code === 2 || error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function mkdirp(sftp, path) {
  if (!path || path === '/' || path === '.') return
  const parts = posix.normalize(path).split('/').filter(Boolean)
  let current = path.startsWith('/') ? '/' : ''
  for (const part of parts) {
    current = current === '/' ? `/${part}` : current ? `${current}/${part}` : part
    try { await callSftp(sftp, 'mkdir', current, { mode: 0o700 }) }
    catch (error) {
      const attrs = await existsAttrs(sftp, current).catch(() => undefined)
      if (!attrs || typeFromMode(attrs.mode) !== 'directory') throw error
    }
  }
}

async function writeBuffer(sftp, path, bytes, mode = 0o600, signal) {
  await mkdirp(sftp, posix.dirname(path))
  const stream = sftp.createWriteStream(path, { flags: 'w', mode })
  return await new Promise((resolve, reject) => {
    const abort = () => stream.destroy(new Error('aborted'))
    if (signal) {
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    stream.on('error', error => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new FsError('write aborted', 'FS_ABORTED'))
      else reject(fsError(error, 'write', path))
    })
    stream.on('close', () => { signal?.removeEventListener('abort', abort); resolve() })
    stream.end(bytes)
  })
}

/**
 * DSH FileSystem provider backed by SSH SFTP.
 *
 * This class owns storage mechanics only. Model-facing read/write/edit schemas,
 * validation, rendering, and observation policy remain the official DSH plugins.
 */
/** `~`, `~/x`, `/abs` and `rel` → one absolute remote path, in that order. */
function spellRemotePath(configured, home, base = home) {
  const text = String(configured ?? '').trim()
  if (text === '' || text === '~') return posix.normalize(home)
  if (text.startsWith('~/')) return posix.normalize(posix.join(home, text.slice(2)))
  if (text.startsWith('/')) return posix.normalize(text)
  return posix.normalize(posix.resolve(base, text))
}

export async function resolveRemoteEnvironment(connections, server, options = {}) {
  const signal = options.signal
  const home = await connections.remoteHome(server, { signal })
  // `options.cwd` overrides the server's configured root: that is how a Session
  // opened inside a remote-directory Workspace starts in that very directory
  // instead of the server's default one.
  const configured = String(options.cwd || '').trim() || String(server.remoteRoot || '~')
  const requested = spellRemotePath(configured, home)
  const sftp = await connections.sftp(server, { signal })
  let cwd
  try { cwd = await callSftp(sftp, 'realpath', requested) }
  catch { cwd = requested }
  return { home: posix.normalize(home), cwd: posix.normalize(cwd) }
}

// Compatibility alias for callers that only need the default cwd. The value is
// deliberately not a filesystem access boundary.
export async function resolveRemoteRoot(connections, server, options = {}) {
  return (await resolveRemoteEnvironment(connections, server, options)).cwd
}

const BROWSE_LIMIT = 500

function compareNames(left, right) {
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
}

/**
 * One SFTP directory listing for the workspace browser.
 *
 * This exists so the browser never invents its own path or SFTP semantics: the
 * requested spelling is resolved exactly like every other remote access
 * (`''`/`~` = the server's home, a relative spelling = relative to the server's
 * default directory), the answer carries the canonical path so the browser can
 * walk back up with `..`, and unreadable or missing directories surface as the
 * same FsError codes the file tools report.
 *
 * `entries` lists directories only, plus symlinks resolved to their target
 * (`type` is the target's kind, `symlink` marks the entry) because a picker that
 * cannot follow a symlinked directory is useless on a real server. `files` are
 * returned only on request, and the answer is capped so one huge directory
 * cannot flood the browser.
 */
export async function listRemoteDirectories(connections, server, requested, options = {}) {
  const signal = options.signal
  const environment = await resolveRemoteEnvironment(connections, server, { signal })
  const spelled = spellRemotePath(requested, environment.home, environment.cwd)
  const sftp = await connections.sftp(server, { signal })
  let path = spelled
  try { path = posix.normalize(await callSftp(sftp, 'realpath', spelled)) } catch { /* keep the spelled path: readdir below reports the real error */ }

  let raw_entries
  try { raw_entries = await callSftp(sftp, 'readdir', path) }
  catch (error) { throw fsError(error, 'list', path) }

  const directories = []
  const files = []
  for (const entry of raw_entries || []) {
    const name = String(entry?.filename || '')
    if (!name || name === '.' || name === '..') continue
    const child = posix.join(path, name)
    let meta = metadata(entry?.attrs, true)
    let symlink = meta.type === 'symlink'
    if (symlink) {
      try { meta = metadata(await callSftp(sftp, 'stat', child)) } catch { symlink = true }
    }
    if (meta.type === 'directory') directories.push({ name, type: 'directory', ...(symlink ? { symlink: true } : {}) })
    else if (options.includeFiles === true) files.push({ name, type: meta.type })
  }
  directories.sort((left, right) => compareNames(left.name, right.name))
  files.sort((left, right) => compareNames(left.name, right.name))
  const limit = Math.max(1, Math.min(2000, Number(options.limit) || BROWSE_LIMIT))
  const entries = [...directories, ...files]
  return {
    path,
    parent: path === '/' ? undefined : posix.dirname(path),
    home: environment.home,
    cwd: environment.cwd,
    entries: entries.slice(0, limit),
    total: entries.length,
    truncated: entries.length > limit,
  }
}

/**
 * Confirm one remote directory before it is adopted as a Workspace, and return
 * its canonical spelling. A typo, a file, or a permission wall therefore fails
 * here — with the file tools' own error codes — instead of leaving a Workspace
 * behind that can never execute anything.
 */
export async function remoteDirectoryInfo(connections, server, requested, options = {}) {
  const signal = options.signal
  const environment = await resolveRemoteEnvironment(connections, server, { signal })
  const spelled = spellRemotePath(requested, environment.home, environment.cwd)
  const sftp = await connections.sftp(server, { signal })
  let path = spelled
  try { path = posix.normalize(await callSftp(sftp, 'realpath', spelled)) } catch { /* stat below reports the reason */ }
  let attrs
  try { attrs = await callSftp(sftp, 'stat', path) }
  catch (error) { throw fsError(error, 'stat', spelled) }
  const meta = metadata(attrs)
  if (meta.type !== 'directory') throw new FsError(`"${path}" 不是目录`, 'FS_NOT_DIRECTORY')
  return { path, home: environment.home, type: meta.type }
}

export class SshFileSystem extends FileSystem {
  constructor(ctx, config) {
    super(ctx)
    this.connections = config.connections
    this.server = structuredClone(config.server)
    this.diffBasisMaxBytes = Math.max(64 * 1024, Number(config.diffBasisMaxBytes) || 10 * 1024 * 1024)

    // Cordis services may be invoked through a traceable shadow receiver. Native
    // JavaScript private fields/methods perform a class-brand check against that
    // receiver and therefore fail even though the shadow resolves this provider.
    // Keep mutable provider state behind one ordinary shared object instead. Every
    // shadow reads the same object reference, so environment caching and write locks stay
    // provider-instance scoped without bypassing Cordis tracing.
    this.runtimeState = {
      locks: new Map(),
      environmentPromise: config.resolvedEnvironment
        ? Promise.resolve({
            home: String(config.resolvedEnvironment.home),
            cwd: String(config.resolvedEnvironment.cwd),
          })
        : undefined,
    }
  }

  async resolvedEnvironment(signal) {
    const state = this.runtimeState
    if (!state.environmentPromise) {
      state.environmentPromise = this._resolveEnvironment(signal).catch(error => {
        state.environmentPromise = undefined
        throw error
      })
    }
    return await state.environmentPromise
  }

  async resolvedRoot(signal) {
    return (await this.resolvedEnvironment(signal)).cwd
  }

  async resolvedHome(signal) {
    return (await this.resolvedEnvironment(signal)).home
  }

  async _resolveEnvironment(signal) {
    return await resolveRemoteEnvironment(this.connections, this.server, { signal })
  }

  async _locked(key, fn) {
    const locks = this.runtimeState.locks
    const previous = locks.get(key) || Promise.resolve()
    const running = previous.then(fn, fn)
    const tail = running.then(() => undefined, () => undefined)
    locks.set(key, tail)
    try { return await running }
    finally { if (locks.get(key) === tail) locks.delete(key) }
  }

  async resolve(path, opts = {}) {
    const environment = await this.resolvedEnvironment(opts.signal)
    const remote = normalizeRemotePath(path, opts.cwd, environment.cwd, environment.home)
    return { targetKey: remoteTargetKey(this.server.id, remote), displayPath: remote }
  }

  processPath(target) { return targetParts(target, this.server.id).path }

  fileUrl(target) {
    const { serverId, path } = targetParts(target, this.server.id)
    const url = new URL('file:///')
    url.hostname = `ywssh-${serverId}`
    url.pathname = path
    return url.href
  }

  contains(parent, child) {
    const p = targetParts(parent, this.server.id)
    const c = targetParts(child, this.server.id)
    const rel = posix.relative(p.path, c.path)
    return rel === '' || (!rel.startsWith('../') && rel !== '..' && !posix.isAbsolute(rel))
  }

  async stat(target, signal) {
    const path = this.processPath(target)
    const sftp = await this.connections.sftp(this.server, { signal })
    try { return metadata(await callSftp(sftp, 'stat', path)) }
    catch (error) {
      if (error?.code === 2 || error?.code === 'ENOENT') return undefined
      throw fsError(error, 'stat', path)
    }
  }

  async lstat(path, opts = {}, signal) {
    const environment = await this.resolvedEnvironment(signal || opts.signal)
    const remote = normalizeRemotePath(path, opts.cwd, environment.cwd, environment.home)
    const sftp = await this.connections.sftp(this.server, { signal: signal || opts.signal })
    try { return metadata(await callSftp(sftp, 'lstat', remote), true) }
    catch (error) {
      if (error?.code === 2 || error?.code === 'ENOENT') return undefined
      throw fsError(error, 'lstat', remote)
    }
  }

  async readText(target, signal) {
    const path = this.processPath(target)
    const sftp = await this.connections.sftp(this.server, { signal })
    return decodeUtf8(await readAll(sftp, path, Infinity, signal), path)
  }

  async streamText(target, signal) {
    const path = this.processPath(target)
    const sftp = await this.connections.sftp(this.server, { signal })
    const attrs = await callSftp(sftp, 'stat', path).catch(error => { throw fsError(error, 'read', path) })
    if (typeFromMode(attrs.mode) !== 'file') throw new FsError(`cannot read "${path}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    const stream = sftp.createReadStream(path)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    async function* iterator() {
      let first = true
      try {
        for await (const chunk of stream) {
          if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
          const bytes = Buffer.from(chunk)
          if (first && bytes.subarray(0, 8192).includes(0)) throw new FsError(`cannot read "${path}": binary file`, 'FS_NOT_TEXT')
          first = false
          yield decoder.decode(bytes, { stream: true })
        }
        const tail = decoder.decode()
        if (tail) yield tail
      } catch (error) {
        if (error instanceof FsError) throw error
        throw new FsError(`cannot read "${path}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
      }
    }
    return iterator()
  }

  async readBytes(target, signal, maxBytes) {
    const path = this.processPath(target)
    const sftp = await this.connections.sftp(this.server, { signal })
    return new Uint8Array(await readAll(sftp, path, Number(maxBytes), signal))
  }

  /**
   * Read one byte window without decoding.
   *
   * The window is the caller's, so it is never refused for size; a client that
   * wants a prefix asks for exactly that prefix.
   */
  async readByteRange(target, range, signal) {
    const path = this.processPath(target)
    const offset = Math.max(0, Math.trunc(Number(range?.offset) || 0))
    const length = Math.max(0, Math.trunc(Number(range?.length) || 0))
    const sftp = await this.connections.sftp(this.server, { signal })
    return new Uint8Array(await readRange(sftp, path, offset, length, signal))
  }

  /**
   * List one directory the way every other backend does.
   *
   * A child that is a symlink is resolved before its entry is reported, so a
   * symlinked directory arrives as a directory and the file tree can expand it
   * (`listRemoteDirectories` resolves links for the same reason, and the local
   * backend probes each child with follow semantics). A link that cannot be
   * followed - dangling, or refused - keeps its own entry type instead of failing
   * the whole listing. `.` and `..` are never entries: no backend reports them.
   */
  async listDir(target, signal) {
    const path = this.processPath(target)
    const sftp = await this.connections.sftp(this.server, { signal })
    let entries
    try { entries = await callSftp(sftp, 'readdir', path) }
    catch (error) { throw fsError(error, 'list', path) }
    const listed = []
    for (const entry of entries || []) {
      if (signal?.aborted) throw new FsError('list aborted', 'FS_ABORTED')
      const name = String(entry?.filename || '')
      if (name.length === 0 || name === '.' || name === '..') continue
      const child = posix.join(path, name)
      let meta = metadata(entry?.attrs, true)
      if (meta.type === 'symlink') {
        try { meta = metadata(await callSftp(sftp, 'stat', child)) } catch { /* keep the link's own entry */ }
      }
      listed.push({
        name,
        type: meta.type,
        target: { targetKey: remoteTargetKey(this.server.id, child), displayPath: child },
        version: meta.version,
        ...(meta.size !== undefined ? { size: meta.size } : {}),
      })
    }
    return listed
  }

  async writeText(target, content, expected, signal, _sandboxPolicy) {
    return this._locked(target.targetKey, async () => {
      const path = this.processPath(target)
      const sftp = await this.connections.sftp(this.server, { signal })
      const current = await existsAttrs(sftp, path).catch(error => { throw fsError(error, 'write', path) })
      if (current && typeFromMode(current.mode) !== 'file') throw new FsError(`cannot write "${path}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (expected?.kind === 'createIfAbsent' && current) throw new FsError(`cannot overwrite existing "${path}" without reading it first`, 'FS_NOT_OBSERVED')
      if (expected?.kind === 'replaceIfVersion' && (!current || versionFromAttrs(current) !== expected.version)) throw new FsError(`cannot write "${path}": file changed since it was read`, 'FS_STALE_VERSION')

      let before
      if (current && Number(current.size) <= this.diffBasisMaxBytes) {
        try { before = decodeUtf8(await readAll(sftp, path, this.diffBasisMaxBytes, signal), path).replaceAll('\r\n', '\n') } catch {}
      }
      const bytes = Buffer.from(String(content), 'utf8')
      const temp = posix.join(posix.dirname(path), `.${posix.basename(path)}.dsh-remote-ssh-${randomUUID()}.tmp`)
      await writeBuffer(sftp, temp, bytes, current ? (Number(current.mode) & 0o777) : 0o600, signal)
      try {
        if (expected?.kind === 'createIfAbsent' && await existsAttrs(sftp, path)) throw new FsError(`cannot overwrite existing "${path}" without reading it first`, 'FS_NOT_OBSERVED')
        if (typeof sftp.ext_openssh_rename === 'function') await callSftp(sftp, 'ext_openssh_rename', temp, path)
        else {
          if (current) { try { await callSftp(sftp, 'unlink', path) } catch {} }
          await callSftp(sftp, 'rename', temp, path)
        }
      } catch (error) {
        try { await callSftp(sftp, 'unlink', temp) } catch {}
        if (error instanceof FsError) throw error
        throw fsError(error, 'write', path)
      }
      const afterAttrs = await callSftp(sftp, 'stat', path)
      return {
        operation: current ? 'update' : 'create',
        version: versionFromAttrs(afterAttrs),
        ...(before !== undefined ? { before } : {}),
        after: String(content).replaceAll('\r\n', '\n'),
      }
    })
  }

  async editText(target, edit, expected, signal, sandboxPolicy) {
    return this._locked(`${target.targetKey}:edit`, async () => {
      const path = this.processPath(target)
      const sftp = await this.connections.sftp(this.server, { signal })
      const attrs = await existsAttrs(sftp, path)
      if (!attrs) throw new FsError(`cannot edit "${path}": not found`, 'FS_NOT_FOUND')
      if (typeFromMode(attrs.mode) !== 'file') throw new FsError(`cannot edit "${path}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (expected?.version && versionFromAttrs(attrs) !== expected.version) throw new FsError(`cannot edit "${path}": file changed since it was read`, 'FS_STALE_VERSION')
      const originalRaw = decodeUtf8(await readAll(sftp, path, Infinity, signal), path)
      const sample = originalRaw.slice(0, 4096)
      const crlf = (sample.match(/\r\n/gu)?.length || 0) > ((sample.match(/(?<!\r)\n/gu)?.length || 0))
      const source = originalRaw.replaceAll('\r\n', '\n')
      const oldString = String(edit?.oldString ?? '').replaceAll('\r\n', '\n')
      const newString = String(edit?.newString ?? '').replaceAll('\r\n', '\n')
      if (!oldString) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
      const count = source.split(oldString).length - 1
      if (count === 0) throw new FsError(`old_string was not found in "${path}"`, 'FS_EDIT_NOT_FOUND')
      if (!edit?.replaceAll && count > 1) throw new FsError(`old_string matched ${count} times in "${path}"`, 'FS_AMBIGUOUS_EDIT')
      const after = edit?.replaceAll ? source.split(oldString).join(newString) : source.replace(oldString, newString)
      const wire = crlf ? after.replaceAll('\n', '\r\n') : after
      const result = await this.writeText(target, wire, { kind: 'replaceIfVersion', version: versionFromAttrs(attrs) }, signal, sandboxPolicy)
      return { version: result.version, before: source, after }
    })
  }

}

export const __test = { typeFromMode, versionFromAttrs, decodeUtf8 }
