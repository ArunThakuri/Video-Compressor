/*
 * Checks how index.html behaves at phone viewport sizes, over http as GitHub
 * Pages serves it.
 *
 * IMPORTANT LIMIT: this drives desktop Chrome with mobile metrics, a mobile UA
 * and touch enabled. That catches layout and flow problems, but it is NOT
 * WebKit. Every iOS browser is WebKit, so iOS behaviour is not covered here.
 *
 *   node test/mobile-check.mjs [baseUrl]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8801'
const fixture = path.join(process.cwd(), 'test', 'source.mp4')

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const VIEWPORTS = [
  { name: 'iPhone 14', width: 390, height: 844, ua: IPHONE_UA, scale: 3 },
  { name: 'Android', width: 360, height: 800, ua: ANDROID_UA, scale: 3 },
  { name: 'small Android', width: 320, height: 640, ua: ANDROID_UA, scale: 2 }
]

const CHROME = path.win32.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
const PORT = 9360 + Math.floor(Math.random() * 400)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-'))

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

let pass = 0, fail = 0
const check = (label, ok, extra) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + (!ok && extra ? '  -> ' + extra : ''))
  ok ? pass++ : fail++
}

for (const vp of VIEWPORTS) {
  console.log(`\n${vp.name}  ${vp.width}x${vp.height} @${vp.scale}x`)

  await send('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: true
  }, sessionId)
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId)
  await send('Emulation.setUserAgentOverride', { userAgent: vp.ua }, sessionId)
  await send('Page.navigate', { url: BASE + '/index.html' }, sessionId)
  await sleep(1200)

  const metrics = await send('Runtime.evaluate', {
    expression: `(() => {
      const de = document.documentElement;
      const over = [];
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > innerWidth + 0.5 || r.left < -0.5)) {
          over.push((el.tagName.toLowerCase()) + '.' + String(el.className).split(' ')[0] +
            ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
        }
      });
      const box = s => { const e = document.querySelector(s); if (!e) return null;
        const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return JSON.stringify({
        innerWidth: innerWidth,
        scrollWidth: de.scrollWidth,
        horizontalOverflow: de.scrollWidth > innerWidth,
        offenders: over.slice(0, 6),
        dropBox: box('.drop'),
        statsCols: getComputedStyle(document.querySelector('.stats') || document.body).gridTemplateColumns.split(' ').length,
        tapTargets: {
          drop: box('.drop'),
          fileInput: box('#file')
        },
        apis: {
          showSaveFilePicker: typeof window.showSaveFilePicker,
          canShare: typeof navigator.canShare,
          share: typeof navigator.share
        }
      });
    })()`, returnByValue: true
  }, sessionId)
  const m = JSON.parse(metrics.result.value)

  check('no horizontal overflow', !m.horizontalOverflow,
    m.offenders.length ? 'offenders: ' + m.offenders.join(', ') : '')
  check('drop zone is a usable tap target (>=44px tall)',
    m.dropBox && m.dropBox.h >= 44, m.dropBox ? m.dropBox.h + 'px' : 'missing')
  check('drop zone fits the viewport', m.dropBox && m.dropBox.w <= m.innerWidth,
    m.dropBox ? m.dropBox.w + ' vs ' + m.innerWidth : '')

  /* Tapping the drop zone must open the file picker. */
  const tap = await send('Runtime.evaluate', {
    expression: `(() => {
      window.__clicked = 0;
      const inp = document.getElementById('file');
      const orig = inp.click.bind(inp);
      inp.click = function () { window.__clicked++; };
      const r = document.querySelector('.drop').getBoundingClientRect();
      window.__tapAt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      return JSON.stringify(window.__tapAt);
    })()`, returnByValue: true
  }, sessionId)
  const at = JSON.parse(tap.result.value)
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }]
  }, sessionId)
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId)
  await sleep(300)
  const tapped = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({ clicked: window.__clicked })', returnByValue: true
  }, sessionId)
  check('tapping the drop zone opens the file picker',
    JSON.parse(tapped.result.value).clicked === 1,
    'clicks=' + JSON.parse(tapped.result.value).clicked)

  /* And the full patch flow must complete. */
  const doc = await send('DOM.getDocument', { depth: 1 }, sessionId)
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' }, sessionId)
  await send('DOM.setFileInputFiles', { files: [fixture], nodeId: node.nodeId }, sessionId)

  let state = null
  for (let i = 0; i < 120; i++) {
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const spinning = !!document.querySelector('#out .spinner');
        const dl = document.querySelector('#out a.btn');
        const reject = document.querySelector('#out .why');
        return JSON.stringify({
          phase: spinning ? 'working' : 'done',
          hasDownload: !!dl, reject: reject ? reject.textContent : null
        });
      })()`, returnByValue: true
    }, sessionId)
    state = JSON.parse(r.result.value)
    if (state.phase === 'done') break
    await sleep(100)
  }
  check('patch completes on a phone viewport',
    !state.reject && state.hasDownload, state.reject || 'no download rendered')

  console.log('       apis here: showSaveFilePicker=' + m.apis.showSaveFilePicker +
    ', navigator.share=' + m.apis.share + ', canShare=' + m.apis.canShare +
    '   (desktop Chrome emulating a phone — NOT indicative of iOS)')

  if (vp.name === 'iPhone 14') {
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
    fs.writeFileSync(path.join(process.cwd(), 'test', '_mobile.png'), Buffer.from(shot.data, 'base64'))
    console.log('       screenshot -> test/_mobile.png')
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
chrome.kill()
process.exit(fail ? 1 : 0)
