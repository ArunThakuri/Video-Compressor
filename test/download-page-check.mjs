/*
 * Guards the two things that are easy to break in a static multi-page site:
 *   - the inline script still parses (a typo would otherwise only show up
 *     as a dead page in a browser), and
 *   - index.html and download.html agree about the navigation.
 *
 *   node test/download-page-check.mjs
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const root = path.join(__dirname, '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { console.log('  ok   ' + label); pass++ }
  else { console.log('  FAIL ' + label + (extra ? '  -> ' + extra : '')); fail++ }
}

const index = read('index.html')
const download = read('download.html')

/* ---------- the inline script parses ---------- */

function inlineScript(html, file) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!m) throw new Error(file + ': no inline <script> block found')
  return m[1]
}

console.log('download.html')
let dlScript
try {
  dlScript = inlineScript(download, 'download.html')
  new vm.Script(dlScript, { filename: 'download.html<script>' })
  check('inline script parses', true)
} catch (e) {
  check('inline script parses', false, e.message)
}

try {
  const idxScript = inlineScript(index, 'index.html')
  new vm.Script(idxScript, { filename: 'index.html<script>' })
  check('index.html inline script still parses', true)
} catch (e) {
  check('index.html inline script still parses', false, e.message)
}

/* ui-test.js runs the FIRST inline <script> through a stubbed DOM. If a second
 * inline block is ever added above the real one, that test silently runs the
 * wrong code. There must be exactly one. */
const inlineCount = (download.match(/<script>/g) || []).length
check('download.html has one inline script', inlineCount === 1, 'found ' + inlineCount)

/* ---------- navigation ---------- */

console.log('\nnavigation')

const navLinks = (html) => {
  const nav = html.match(/<nav class="links"[\s\S]*?<\/nav>/)
  if (!nav) return null
  return [...nav[0].matchAll(/<a href="([^"]+)"([^>]*)>([^<]+)<\/a>/g)]
    .map(m => ({ href: m[1], active: /class="on"/.test(m[2]), label: m[3].trim() }))
}

const dlNav = navLinks(download)
const idxNav = navLinks(index)

check('download.html has a nav', !!dlNav)
check('index.html has a nav', !!idxNav)
check('both navs list the same links',
  !!dlNav && !!idxNav && dlNav.map(l => l.href).join() === idxNav.map(l => l.href).join(),
  !dlNav || !idxNav ? 'a nav is missing' : (dlNav || []).map(l => l.href).join())
check('exactly one link is marked current on each page',
  !!dlNav && dlNav.filter(l => l.active).length === 1 &&
  !!idxNav && idxNav.filter(l => l.active).length === 1)
check('download.html marks Download as current',
  !!dlNav && dlNav.some(l => l.href === 'download.html' && l.active))
check('index.html marks Optimize as current',
  !!idxNav && idxNav.some(l => l.href === 'index.html' && l.active))

/* ---------- the file:// promise ---------- */

console.log('\nself-contained pages')

for (const [file, html] of [['index.html', index], ['download.html', download]]) {
  const remoteScripts = [...html.matchAll(/<script[^>]+src="(https?:)?\/\/[^"]+"/g)]
  const remoteStyles = [...html.matchAll(/<link[^>]+href="(https?:)?\/\/[^"]+"/g)]
  check(file + ' loads no remote script or stylesheet',
    remoteScripts.length === 0 && remoteStyles.length === 0,
    [...remoteScripts, ...remoteStyles].map(m => m[0]).join(' '))
}

const dlSrcs = [...download.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1])
check('download.html needs no local script file either', dlSrcs.length === 0,
  dlSrcs.join(' '))

/* ---------- the page must never buffer the video ---------- */

console.log('\nstreaming, not buffering')

check('download navigates instead of fetching into a blob',
  /window\.location\.href\s*=\s*apiBase\(\)\s*\+\s*'\/api\/download/.test(dlScript))
check('page never creates an object URL for the video',
  !/createObjectURL/.test(dlScript))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
