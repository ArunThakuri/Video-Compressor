/*
 * Drives index.html's inline UI script against a stubbed DOM, so the real
 * drop -> FileReader -> patch -> download path is exercised outside a browser.
 *   node test/ui-test.js
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

/* ---------- minimal DOM ---------- */

class Node {
  constructor(tag) {
    this.tagName = tag
    this.children = []
    this.className = ''
    this._text = ''
    this.attrs = {}
    this.listeners = {}
    this.classList = {
      add: (c) => { if (!this.className.includes(c)) this.className += ' ' + c },
      remove: (c) => { this.className = this.className.replace(c, '').trim() }
    }
  }
  appendChild(c) { this.children.push(c); c.parent = this; return c }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c }
  remove() { if (this.parent) this.parent.removeChild(this) }
  get firstChild() { return this.children[0] || null }
  set textContent(v) { this._text = String(v); this.children = [] }
  get textContent() {
    return this._text + this.children.map(c => c.textContent).join('')
  }
  set innerHTML(v) { this._text = ''; this.children = [] }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn) }
  click() {}
  closest() { return null }
}

const byId = {}
;['drop', 'file', 'out', 'recents', 'ver'].forEach(id => { byId[id] = new Node('div') })

const document = {
  getElementById: (id) => byId[id] || (byId[id] = new Node('div')),
  createElement: (t) => new Node(t),
  createTextNode: (t) => { const n = new Node('#text'); n._text = String(t); return n }
}

/* FileReader: resolve synchronously from a buffer. */
class FileReader {
  readAsArrayBuffer(file) {
    this.result = file._bytes.buffer.slice(
      file._bytes.byteOffset, file._bytes.byteOffset + file._bytes.byteLength)
    if (this.onload) this.onload()
  }
}

const store = {}
const sandbox = {
  document,
  window: { addEventListener: () => {} },
  FileReader,
  /* A real Blob concatenates its parts; the UI now hands it the whole parts
   * array, so the stub must too or it would only ever see the first box. */
  Blob: class {
    constructor(parts) {
      this.parts = parts
      this.bytes = Buffer.concat(parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength)))
      this.size = this.bytes.length
    }
  },
  URL: { createObjectURL: (b) => { const u = 'blob:test/' + Object.keys(store).length; store[u] = b; return u } },
  performance: { now: () => Date.now() },
  console,
  MP4Patch: null
}
sandbox.self = sandbox
vm.createContext(sandbox)

/* engine.js registers itself as a global when there is no `module`. */
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8'),
  sandbox, { filename: 'engine.js' })
if (!sandbox.MP4Patch) throw new Error('engine.js did not register MP4Patch')

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
const ui = html.match(/<script>([\s\S]*?)<\/script>/)[1]
vm.runInContext(ui, sandbox, { filename: 'index.html<script>' })

/* ---------- feed files through the UI ---------- */

function fileFor(p) {
  const bytes = fs.readFileSync(p)
  return { name: path.basename(p), _bytes: bytes }
}

const out = byId.out
const recents = byId.recents

function find(node, pred, acc = []) {
  if (pred(node)) acc.push(node)
  node.children.forEach(c => find(c, pred, acc))
  return acc
}

const cases = [
  ['test/source.mp4', true],
  ['test/noFaststart.mp4', true],
  ['test/hevc.mp4', true],
  ['test/source.mov', true],
  ['test/meta_iso.mp4', true],   /* meta as an ISO FullBox */
  ['test/meta_qt.mp4', true],    /* meta in QuickTime shape - regression */
  ['test/mdat64.mp4', true],     /* 64-bit mdat header - regression */
  ['test/frag.mp4', false],
  ['test/vp9.mp4', false]
]

/* The UI pipeline is async (it awaits the file read and, for large files, a
 * save handle), so wait for the in-flight spinner to clear before asserting. */
async function settle() {
  for (let i = 0; i < 200; i++) {
    if (find(out, n => String(n.className).includes('spinner')).length === 0) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('pipeline never settled')
}

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { console.log('  ok   ' + label); pass++ }
  else { console.log('  FAIL ' + label + (extra ? '  -> ' + extra : '')); fail++ }
}

async function run() {
for (const [rel, shouldPatch] of cases) {
  const p = path.join(__dirname, '..', rel)
  if (!fs.existsSync(p)) { console.log('  skip ' + rel + ' (missing)'); continue }

  byId.out.children = []
  byId.recents.children = []

  const input = byId.file
  input.files = [fileFor(p)]
  input.listeners.change.forEach(fn => fn())
  await settle()


  const reject = find(out, n => n.className.includes('reject'))
  const name = path.basename(rel)

  console.log('\n' + name)
  const whyEl = find(out, n => n.className === 'why')[0]
  if (whyEl) console.log('       reason: ' + whyEl.textContent)
  if (shouldPatch) {
    const dl = find(out, n => n.download)
    check('renders a download', dl.length === 1, 'found ' + dl.length)
    check('no reject card', reject.length === 0)
    if (dl.length) {
      const meta = find(out, n => n.className === 'card-meta')[0]
      const text = meta ? meta.textContent : ''
      check('reports size change', /\d.*→.*\d/.test(text), text)
      check('output named .optimized.mp4', /\.optimized\.mp4$/.test(dl[0].download), dl[0].download)
      const blob = store[dl[0].href]
      check('blob is non-empty', blob && blob.size > 1000, blob && String(blob.size))
      /* The download is assembled from the parts array, so verify that
       * concatenating them really does yield a valid patched file. */
      if (blob) {
        check('blob built from multiple parts', blob.parts.length > 1,
          'parts=' + blob.parts.length)
        const info = sandbox.MP4Patch.inspect(blob.bytes)
        check('blob is already-patched', info.alreadyPatched === true)
      }
    }
    check('added to recents', recents.children.length === 1, String(recents.children.length))
  } else {
    check('renders a reject card', reject.length === 1, 'found ' + reject.length)
    check('no download offered', find(out, n => n.download).length === 0)
    const why = find(out, n => n.className === 'why')[0]
    console.log('       reason: ' + (why ? why.textContent : '(none)'))
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('harness error:', e.message); process.exit(1) })
