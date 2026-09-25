#!/usr/bin/env node
/*
 * patch.js — patch an MP4/MOV so ingest pipelines skip destructive re-encoding.
 *
 *   node patch.js input.mp4                     -> input.optimized.mp4
 *   node patch.js input.mp4 -o out.mp4
 *   node patch.js input.mp4 --tag "Lavf61.7.100"
 *   node patch.js input.mp4 --no-tag
 *   node patch.js input.mp4 --faststart
 *   node patch.js input.mp4 --inspect           (report only, writes nothing)
 *   node patch.js *.mp4 --outdir out/
 */
'use strict'

const fs = require('fs')
const path = require('path')
const MP4Patch = require('./engine.js')

const USAGE = `
mp4-patch — container-level MP4/MOV optimizer. No re-encoding.

Usage:
  node patch.js <input...> [options]

Options:
  -o, --out <file>      Output path (single input only)
      --outdir <dir>    Output directory (multiple inputs)
      --suffix <s>      Suffix for auto-named outputs (default: .optimized)
      --tag <string>    Encoder tag to write into ©too (default: ${MP4Patch.DEFAULT_TAG})
      --no-tag          Skip writing an encoder tag
      --any-codec       Patch regardless of the video codec tag
      --faststart       Move moov ahead of mdat
      --inspect         Print track/container info and exit without writing
      --force           Overwrite existing output files
  -h, --help            This text
`

function parseArgs(argv) {
  const opts = { inputs: [], suffix: '.optimized', faststart: false, inspect: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') opts.help = true
    else if (a === '-o' || a === '--out') opts.out = argv[++i]
    else if (a === '--outdir') opts.outdir = argv[++i]
    else if (a === '--suffix') opts.suffix = argv[++i]
    else if (a === '--tag') opts.tag = argv[++i]
    else if (a === '--no-tag') opts.tag = ''
    else if (a === '--any-codec') opts.anyCodec = true
    else if (a === '--faststart') opts.faststart = true
    else if (a === '--inspect') opts.inspect = true
    else if (a === '--force') opts.force = true
    else if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(2) }
    else opts.inputs.push(a)
  }
  return opts
}

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes, u = 0
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++ }
  return `${n.toFixed(u === 0 ? 0 : 1)} ${units[u]}`
}

function seconds(s) {
  const m = Math.floor(s / 60)
  const r = (s - m * 60).toFixed(2)
  return m ? `${m}m ${r}s` : `${r}s`
}

function inspectOne(file) {
  const buf = fs.readFileSync(file)
  const info = MP4Patch.inspect(buf)
  console.log(`\n${path.basename(file)}`)
  console.log(`  brand            ${info.brand.trim()}`)
  console.log(`  size             ${human(info.fileSize)}`)
  console.log(`  moov before mdat ${info.moovBeforeMdat ? 'yes' : 'no (not faststart)'}`)
  console.log(`  mvhd version     ${info.mvhdVersion}`)
  console.log(`  duration         ${seconds(info.durationSeconds)}`)
  console.log(`  already patched  ${info.alreadyPatched ? 'YES' : 'no'}`)
  console.log(`  video codec      ${info.videoCodec}`)
  for (const t of info.tracks) {
    console.log(`  ${t.handler} track       ${t.codec} · ${t.samples} samples · ` +
      `stsc runs ${t.stscRunCount} · stts runs ${t.sttsRunCount} · ` +
      `${t.constantFrameRate ? 'constant' : 'VARIABLE'} frame rate`)
  }
  const compat = MP4Patch.checkCompatibility(buf)
  console.log(`  patchable        ${compat.compatible ? 'yes' : 'NO — ' + compat.reason}`)
  return compat.compatible
}

function patchOne(file, outPath, opts, used) {
  const buf = fs.readFileSync(file)
  const t0 = Date.now()
  const result = MP4Patch.quickPatch(buf, {
    tag: opts.tag === undefined ? MP4Patch.DEFAULT_TAG : opts.tag,
    faststart: opts.faststart,
    allowAnyCodec: !!opts.anyCodec
  })
  const report = result.report
  const outSize = result.size
  const ms = Date.now() - t0

  /* A relabelled MOV is an MP4 now, so name it like one. Then de-duplicate:
   * two inputs can share a basename across extensions (clip.mp4 / clip.mov). */
  if (!opts.out) {
    if (report.remuxed && !/\.mp4$/i.test(outPath)) {
      outPath = outPath.replace(/\.[^.]+$/, '') + '.mp4'
    }
    if (used) {
      const dir = path.dirname(outPath)
      const stem = path.basename(outPath, path.extname(outPath))
      const ext = path.extname(outPath)
      let n = 2
      while (used.has(outPath.toLowerCase())) {
        outPath = path.join(dir, `${stem}-${n}${ext}`)
        n++
      }
      used.add(outPath.toLowerCase())
    }
  }

  const dir = path.dirname(outPath)
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  if (fs.existsSync(outPath) && !opts.force) {
    console.error(`  ! ${outPath} exists — skipping (use --force to overwrite)`)
    return false
  }

  /* Write the parts straight through instead of concatenating them first, so
   * the output is never held in memory as one extra copy of the file. */
  const fd = fs.openSync(outPath, 'w')
  try {
    for (const part of result.parts) {
      fs.writeSync(fd, Buffer.from(part.buffer, part.byteOffset, part.byteLength))
    }
  } finally {
    fs.closeSync(fd)
  }

  const pct = (outSize / buf.length - 1) * 100
  console.log(`  -> ${outPath}`)
  console.log(`     ${human(buf.length)} -> ${human(outSize)} ` +
    `(${pct >= 0 ? '+' : ''}${pct.toFixed(3)}%) in ${ms}ms`)
  console.log(`     moov grew ${report.moovGrew >= 0 ? '+' : ''}${report.moovGrew} B · ` +
    `chunk offsets shifted ${report.shifted >= 0 ? '+' : ''}${report.shifted} B` +
    (report.remuxed ? ' · relabelled MOV -> MP4' : '') +
    (report.tag ? `\n     encoder tag "${report.tag}"` : '\n     no encoder tag written'))
  return true
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || (!opts.inputs.length && !opts.inspect)) { console.log(USAGE); process.exit(opts.help ? 0 : 2) }
  if (!opts.inputs.length) { console.log(USAGE); process.exit(2) }
  if (opts.out && opts.inputs.length > 1) {
    console.error('--out takes a single input; use --outdir for batches.'); process.exit(2)
  }

  let ok = 0, failed = 0
  const used = new Set()
  for (const file of opts.inputs) {
    if (!fs.existsSync(file)) { console.error(`! not found: ${file}`); failed++; continue }
    try {
      if (opts.inspect) { inspectOne(file) ? ok++ : failed++; continue }

      const ext = path.extname(file)
      const base = path.basename(file, ext)
      const outPath = opts.out
        ? opts.out
        : path.join(opts.outdir || path.dirname(file), base + opts.suffix + ext)

      console.log(`\n${path.basename(file)}`)
      patchOne(file, outPath, opts, used) ? ok++ : failed++
    } catch (e) {
      console.error(`  ! ${e.message}`)
      failed++
    }
  }

  if (opts.inputs.length > 1 || failed) {
    console.log(`\n${ok} patched, ${failed} failed.`)
  }
  process.exit(failed ? 1 : 0)
}

main()
