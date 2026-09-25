/*
 * Verifies the one thing in index.html that file:// could plausibly break:
 * that an <a download> pointing at a blob: URL actually saves a file when the
 * page itself is loaded over file://.
 *
 * Chrome ignores the download attribute on a programmatic .click() (no user
 * gesture), so this dispatches a real mouse event via CDP. Requires Chrome.
 *
 *   node test/file-download-check.mjs               # file:// (the real case)
 *   node test/file-download-check.mjs <http-url>    # control
 */
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = path.win32.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
const PORT = 9334
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'))
const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'))

const url = process.argv[2] || pathToFileURL(path.join(process.cwd(), 'test', 'file-download-check.html')).href

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function version() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() }
    catch { await sleep(250) }
  }
  throw new Error('chrome did not come up')
}

let ws
let id = 0
const pending = new Map()
const events = []

function send(method, params = {}, sessionId) {
  const msg = { id: ++id, method, params }
  if (sessionId) msg.sessionId = sessionId
  return new Promise((res, rej) => {
    pending.set(msg.id, { res, rej })
    ws.send(JSON.stringify(msg))
    setTimeout(() => {
      if (pending.has(msg.id)) { pending.delete(msg.id); rej(new Error(method + ' timed out')) }
    }, 8000)
  })
}

const v = await version()
ws = new WebSocket(v.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method) { events.push(m.method + ' ' + JSON.stringify(m.params).slice(0, 160)); return }
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) rej(new Error(m.error.message))
    else res(m.result)
  }
})

/* Browser-level, not page-level — this is what headless needs to actually
 * write downloads to disk. */
await send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: dl,
  eventsEnabled: true
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })

await send('Page.navigate', { url }, sessionId)
await sleep(1500)

/* A real mouse click on the link — Chrome ignores the download attribute for
 * a programmatic .click() because there is no user gesture. */
const rect = await send('Runtime.evaluate', {
  expression: 'JSON.stringify(document.getElementById("dl").getBoundingClientRect())',
  returnByValue: true
}, sessionId)
const r = JSON.parse(rect.result.value)
const x = r.x + r.width / 2, y = r.y + r.height / 2

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
await sleep(3000)

const files = fs.readdirSync(dl)
console.log('page url  :', url)
console.log('downloads :', files.length ? files.join(', ') : '(none)')
if (events.length) console.log('events    :', events.join('\n            '))

const hit = files.find((f) => f.startsWith('dltest'))
if (hit) {
  const st = fs.statSync(path.join(dl, hit))
  console.log(`RESULT: blob download WORKS -> ${hit} (${st.size} bytes)`)
} else {
  console.log('RESULT: blob download did NOT produce a file')
}

chrome.kill()
process.exit(hit ? 0 : 1)
