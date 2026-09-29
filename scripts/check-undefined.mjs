// Dependency-free "no undefined calls" gate for `src`.
//
// Some plugin modules can only be imported inside DSH (`remote-realm.js` imports
// official packages that exist in the Host's module graph), so `node --test` can
// never execute them and an undefined identifier survives every test. This check
// reads them as text instead: every name used as a call must be bound in the same
// module - by an import, a declaration, a parameter, a catch binding - or be a
// JavaScript global.
//
// It is a heuristic, deliberately permissive where a text scan cannot be sure:
// names introduced by complex patterns are treated as bound, and unmatched text
// only ever reduces what is inspected. Its failure mode is therefore a missed
// report, never a false alarm on correct code.
import fs from 'node:fs'
import path from 'node:path'

const GLOBALS = new Set([
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'Buffer', 'DataView', 'Date', 'Error', 'EvalError',
  'FinalizationRegistry', 'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int16Array',
  'Int32Array', 'Int8Array', 'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise',
  'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String',
  'Symbol', 'SyntaxError', 'TextDecoder', 'TextEncoder', 'TypeError', 'URIError', 'URL', 'URLSearchParams',
  'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakRef', 'WeakSet',
  'AbortController', 'AbortSignal', 'Atomics', 'decodeURI', 'decodeURIComponent', 'encodeURI',
  'encodeURIComponent', 'escape', 'eval', 'fetch', 'globalThis', 'isFinite', 'isNaN', 'parseFloat',
  'parseInt', 'queueMicrotask', 'require', 'setImmediate', 'setInterval', 'setTimeout', 'structuredClone',
  'clearImmediate', 'clearInterval', 'clearTimeout', 'undefined', 'unescape', 'process', 'console',
])

// Words that may precede `(` without being calls.
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await', 'yield',
  'do', 'else', 'delete', 'void', 'in', 'of', 'case', 'throw', 'super', 'this', 'class', 'import',
  'export', 'extends', 'instanceof', 'with', 'default', 'let', 'const', 'var', 'try', 'finally',
  'async',
])

/** Remove comments first (they carry prose apostrophes), then string bodies. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

function stripStrings(text) {
  let out = ''
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote.length === 0) {
      if (character === '"' || character === "'" || character === '`') {
        quote = character
        out += ' '
        continue
      }
      out += character
      continue
    }
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === quote) quote = ''
    else if (character === '\n') out += '\n'
  }
  return out
}

const identifiers = text => [...text.matchAll(/[A-Za-z_$][\w$]*/g)].map(match => match[0])

function declaredNames(code) {
  const declared = new Set()
  const add = text => { for (const name of identifiers(text)) declared.add(name) }
  for (const match of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    declared.add(match[1])
    add(match[2])
  }
  for (const match of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1])
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1])
  for (const match of code.matchAll(/\b(?:const|let|var)\s*[{[][^}\]]*[}\]]/g)) add(match[0])
  for (const match of code.matchAll(/\bcatch\s*\(([^)]*)\)/g)) add(match[1])
  for (const match of code.matchAll(/\(([^()]*)\)\s*=>/g)) add(match[1])
  for (const match of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(match[1])
  for (const match of code.matchAll(/\bimport\s+([\s\S]*?)\s+from\s/g)) {
    const clause = match[1].replace(/^\s*type\s+/, '')
    for (const name of identifiers(clause)) {
      if (name === 'as' || name === 'type') continue
      declared.add(name)
    }
  }
  for (const name of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) declared.add(name[1])
  return declared
}

function calledNames(code) {
  const calls = new Map()
  for (const match of code.matchAll(/(^|[^\w$.\]#])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[2]
    if (KEYWORDS.has(name)) continue
    const open = match.index + match[0].length - 1
    let depth = 0
    let close = -1
    for (let index = open; index < code.length; index += 1) {
      if (code[index] === '(') depth += 1
      else if (code[index] === ')') {
        depth -= 1
        if (depth === 0) { close = index; break }
      }
    }
    if (close === -1) continue
    // `... { get name(...) {`, `async name(...) {`, `name(...) {` at the start of a
    // line, and `, name(...) {` define a method rather than call one.
    const nameStart = match.index + match[1].length
    const line = code.slice(code.lastIndexOf('\n', nameStart) + 1, nameStart)
    const defines = /(?:^|[\n{,;}])\s*(?:(?:async|static|get|set)\s+|\*\s*)?$/.test(line)
    if (defines && /^\s*\{/.test(code.slice(close + 1))) continue
    if (!calls.has(name)) calls.set(name, match.index)
  }
  return calls
}

const directory = process.argv[2] || 'src'
const files = fs.readdirSync(directory).filter(name => name.endsWith('.js')).sort()
const findings = []
for (const name of files) {
  const file = path.join(directory, name)
  const original = fs.readFileSync(file, 'utf8')
  const code = stripStrings(stripComments(original))
  const declared = declaredNames(code)
  for (const [called, index] of calledNames(code)) {
    if (declared.has(called) || GLOBALS.has(called)) continue
    const line = code.slice(0, index).split('\n').length
    findings.push(`${file}:${line}: ${called}() is not bound in this module`)
  }
}

console.log(`check-undefined: ${files.length} file(s) in ${directory}, ${findings.length} finding(s)`)
for (const finding of findings) console.log(`  ${finding}`)
if (findings.length > 0) process.exitCode = 1
