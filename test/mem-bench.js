/*
 * Compares peak buffer memory for the two output shapes.
 *   node --expose-gc test/mem-bench.js [files...]
 */
'use strict'

const fs = require('fs')
const path = require('path')
const MP4Patch = require('../engine.js')

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['test/res_1080p60_h264.mp4', 'test/res_4k30_h264.mp4', 'test/res_4k60_h264.mp4']

const mb = (b) => (b / 1048576).toFixed(1)
const buffers = () => process.memoryUsage().arrayBuffers

function reset() { if (global.gc) { global.gc(); global.gc() } return buffers() }

console.log('Measured as a multiple of input size. "browser peak" is what a tab')
console.log('actually holds when the result is handed to a download.\n')
console.log('file                     size     parts    +Blob    concat   +Blob')
console.log('-'.repeat(70))

for (const rel of files) {
  const p = path.join(__dirname, '..', rel)
  if (!fs.existsSync(p)) { console.log(rel + '  MISSING'); continue }

  const buf = fs.readFileSync(p)
  const size = buf.length

  /* parts path: output stays views onto the input */
  let base = reset()
  const r1 = MP4Patch.quickPatch(buf)
  const partsOnly = buffers() - base
  const blob1 = new Blob(r1.parts)
  const partsBlob = buffers() - base
  void blob1

  /* concat path: one full extra copy of the file */
  base = reset()
  const r2 = MP4Patch.quickPatch(buf)
  const flat = r2.data
  const concatOnly = buffers() - base
  const blob2 = new Blob([flat])
  const concatBlob = buffers() - base
  void blob2

  console.log(
    path.basename(rel).padEnd(23) +
    (mb(size) + 'MB').padStart(8) +
    ((partsOnly / size).toFixed(2) + 'x').padStart(8) +
    ((partsBlob / size).toFixed(2) + 'x').padStart(9) +
    ((concatOnly / size).toFixed(2) + 'x').padStart(9) +
    ((concatBlob / size).toFixed(2) + 'x').padStart(9)
  )
}
