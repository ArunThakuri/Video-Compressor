/*
 * Exercises both outcomes of the streaming-save path in index.html.
 *
 * showSaveFilePicker is a native dialog that cannot be driven headlessly, so it
 * is overridden before the page scripts run. The page hashes what it wrote and
 * returns only the digest, which is compared against the digest of the same
 * patch produced by the engine directly.
 *
 *   node test/stream-save-check.mjs [fixture] [stream|cancel]
 *
 * stream - the handle resolves and the parts are written (default)
 * cancel - the picker rejects with AbortError, as a user pressing Cancel does;
 *          the page must fall back to an in-memory blob and a Download button
 */
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const MP4Patch = require('../engine.js')

const fixture = process.argv[2] || 'test/source.mp4'
const mode = process.argv[3] || 'stream'
const abs = path.join(process.cwd(), fixture)
if (!fs.existsSync(abs)) { console.error('missing fixture: ' + fixture); process.exit(2) }

const src = fs.readFileSync(abs)
const expected = MP4Patch.quickPatch(src)
const expectedHash = createHash('sha256').update(Buffer.from(expected.data)).digest('hex')

const STREAM_INIT = `
  window.__probeRan = 1;
  window.MP4_STREAM_THRESHOLD = 0;
  window.__sink = null;
  window.showSaveFilePicker = async function (opts) {
    try {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle(opts.suggestedName, { create: true });
      window.__sink = { kind: 'opfs', handle: h, name: opts.suggestedName };
      return h;
    } catch (e) {
      window.__opfsError = String(e && e.message ? e.message : e);
      window.__sink = { kind: 'stub', chunks: [], closed: false, name: opts.suggestedName };
      return {
        name: opts.suggestedName,
        async createWritable() {
          return {
            async write(chunk) { window.__sink.chunks.push(new Uint8Array(chunk)); },
            async close() { window.__sink.closed = true; }
          };
        }
      };
    }
  };
`

const CANCEL_INIT = `
  window.__probeRan = 1;
  window.MP4_STREAM_THRESHOLD = 0;
  window.__sink = null;
  window.__cancelled = 0;
  window.showSaveFilePicker = async function () {
    window.__cancelled++;
    throw new DOMException('The user aborted a request.', 'AbortError');
  };
`

const SHARE_INIT = `
  window.__probeRan = 1;
  window.__shared = null;
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: function (d) { return !!(d && d.files && d.files.length); }
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async function (d) {
      const f = d.files[0];
      const buf = new Uint8Array(await f.arrayBuffer());
      const h = await crypto.subtle.digest('SHA-256', buf);
      window.__shared = {
        name: f.name, size: f.size, count: d.files.length,
        hex: [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('')
      };
    }
  });
`

const HASH_EXPR = `(async () => {
  const sink = window.__sink;
  if (!sink) return JSON.stringify({ none: true, cancelled: window.__cancelled || 0 });
  let bytes;
  if (sink.kind === 'opfs') {
    const f = await sink.handle.getFile();
    bytes = new Uint8Array(await f.arrayBuffer());
  } else {
    const n = sink.chunks.reduce((a, c) => a + c.length, 0);
    bytes = new Uint8Array(n);
    let o = 0;
    for (const c of sink.chunks) { bytes.set(c, o); o += c.length; }
  }
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return JSON.stringify({
    hex: [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''),
    size: bytes.length,
    chunks: sink.kind === 'stub' ? sink.chunks.length : null,
    closed: sink.kind === 'stub' ? sink.closed : null
  });
})()`

const CHROME = path.win32.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
const PORT = 9340 + Math.floor(Math.random() * 400)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-'))
const url = pathToFileURL(path.join(process.cwd(), 'index.html')).href

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws, id = 0
const pending = new Map()
function send(method, params = {}, sessionId) {
  const msg = { id: ++id, method, params }
  if (sessionId) msg.sessionId = sessionId
  return new Promise((res, rej) => {
    pending.set(msg.id, { res, rej })
    ws.send(JSON.stringify(msg))
    setTimeout(() => { if (pending.has(msg.id)) { pending.delete(msg.id); rej(new Error(method + ' timeout')) } }, 15000)
  })
}

async function ver() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() } catch { await sleep(250) }
  }
  throw new Error('no chrome')
}

const v = await ver()
ws = new WebSocket(v.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id)
    m.error ? rej(new Error(m.error.message)) : res(m.result)
  }
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
/* Tall enough that the result card is on screen: a click at coordinates below
 * the viewport would silently miss. */
await send('Emulation.setDeviceMetricsOverride',
  { width: 1000, height: 1600, deviceScaleFactor: 1, mobile: false }, sessionId)
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: mode === 'cancel' ? CANCEL_INIT : (mode === 'share' ? SHARE_INIT : STREAM_INIT)
}, sessionId)
await send('Page.navigate', { url }, sessionId)
await sleep(1500)

const pre = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ probeRan: window.__probeRan, threshold: window.MP4_STREAM_THRESHOLD })`,
  returnByValue: true
}, sessionId)
if (JSON.parse(pre.result.value).probeRan !== 1) {
  console.error('harness error: init script did not run'); chrome.kill(); process.exit(1)
}

const doc = await send('DOM.getDocument', { depth: 1 }, sessionId)
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' }, sessionId)
if (!node.nodeId) throw new Error('#file not found')
await send('DOM.setFileInputFiles', { files: [abs], nodeId: node.nodeId }, sessionId)

let state = null
for (let i = 0; i < 120; i++) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const spinning = !!document.querySelector('#out .spinner');
      const saved = document.querySelector('#out .saved');
      const dl = document.querySelector('#out a.btn');
      const reject = document.querySelector('#out .why');
      return JSON.stringify({
        phase: spinning ? 'working' : 'done',
        savedText: saved ? saved.textContent : null,
        hasDownload: !!dl,
        reject: reject ? reject.textContent : null,
        sinkKind: window.__sink ? window.__sink.kind : null,
        opfsError: window.__opfsError || null,
        cancelled: window.__cancelled || 0
      });
    })()`, returnByValue: true
  }, sessionId)
  state = JSON.parse(r.result.value)
  if (state.phase === 'done') break
  await sleep(100)
}

const digest = await send('Runtime.evaluate', {
  expression: HASH_EXPR, returnByValue: true, awaitPromise: true
}, sessionId)
const got = JSON.parse(digest.result.value)

let pass = 0, fail = 0
const check = (label, ok, extra) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (!ok && extra ? '  -> ' + extra : ''))
  ok ? pass++ : fail++
}

console.log('\nmode           :', mode, '·', fixture)
console.log('reject         :', state.reject || 'none')
if (state.opfsError) console.log('OPFS note      :', state.opfsError)

if (mode === 'share') {
  const btnInfo = await send('Runtime.evaluate', {
    expression: `(() => {
      const b = document.querySelector('#out .actions button');
      if (!b) return JSON.stringify({ found: false, actions: !!document.querySelector('#out .actions') });
      const r = b.getBoundingClientRect();
      return JSON.stringify({ found: true, label: b.textContent,
        x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        innerHeight: innerHeight, inViewport: r.top >= 0 && r.bottom <= innerHeight });
    })()`, returnByValue: true
  }, sessionId)
  const bi = JSON.parse(btnInfo.result.value)

  console.log('share button   :', bi.found ? bi.label : '(not rendered)')
  check('Share button rendered alongside Download', bi.found === true, JSON.stringify(bi))
  check('Download still offered', state.hasDownload === true)

  if (bi.found) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bi.x, y: bi.y, button: 'left', clickCount: 1 }, sessionId)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bi.x, y: bi.y, button: 'left', clickCount: 1 }, sessionId)
    await sleep(800)
  }

  const post = await send('Runtime.evaluate', {
    expression: `(() => {
      const b = document.querySelector('#out .actions button');
      return JSON.stringify({
        labelAfter: b ? b.textContent : null,
        disabledAfter: b ? b.disabled : null,
        actionsHtml: document.querySelector('#out .actions')
          ? document.querySelector('#out .actions').children.length : 0
      });
    })()`, returnByValue: true
  }, sessionId)
  console.log('after click    :', post.result.value)

  const shared = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__shared)', returnByValue: true
  }, sessionId)
  const sh = JSON.parse(shared.result.value)
  console.log('shared         :', sh ? (sh.count + ' file, ' + sh.size + ' bytes') : 'nothing')
  console.log('')
  check('navigator.share called', !!sh, 'nothing shared')
  if (sh) {
    check('shared exactly one file', sh.count === 1, String(sh.count))
    check('shared file named .optimized.mp4', /\.optimized\.mp4$/.test(sh.name), sh.name)
    check('shared bytes are byte-identical to the engine output',
      sh.hex === expectedHash && sh.size === expected.size, sh.size + ' vs ' + expected.size)
  }
} else if (mode === 'cancel') {
  console.log('picker calls   :', state.cancelled)
  console.log('card shows     :', state.hasDownload ? 'Download button' : (state.savedText || '(nothing)'))
  console.log('')
  check('picker was invoked', state.cancelled === 1, 'calls=' + state.cancelled)
  check('fell back to a Download button', state.hasDownload, 'savedText=' + state.savedText)
  check('no saved-to-disk state claimed', !state.savedText, state.savedText)
  check('still patched without error', !state.reject, state.reject)
  check('nothing written to disk', got.none === true, JSON.stringify(got))
} else {
  console.log('sink           :', state.sinkKind + (state.sinkKind === 'opfs'
    ? '  (real FileSystemFileHandle + real writable stream)'
    : '  (stub — OPFS is blocked on this origin, so only the write loop is exercised)'))
  console.log('card shows     :', state.hasDownload ? 'Download button' : (state.savedText || '(nothing)'))
  console.log('')
  console.log('expected size  :', expected.size)
  console.log('written size   :', got.size)
  console.log('expected sha256:', expectedHash)
  console.log('written sha256 :', got.hex)
  if (got.chunks !== null) console.log('write calls    :', got.chunks, '· closed =', got.closed)
  console.log('')
  check('card shows a saved-to-disk state', !!state.savedText, state.savedText)
  check('no Download button offered', !state.hasDownload)
  check('no reject card', !state.reject, state.reject)
  check('bytes are byte-identical to the engine output',
    got.hex === expectedHash && got.size === expected.size,
    got.size + ' vs ' + expected.size)
  if (got.chunks !== null) check('stream was closed', got.closed === true)
}

console.log(`\n${pass} passed, ${fail} failed`)
chrome.kill()
process.exit(fail ? 1 : 0)
