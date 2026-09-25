/*!
 * mp4-patch — MP4 container metadata patcher.
 *
 * Rewrites the moov atom of an MP4/MOV so the container presents the shape
 * that streaming ingest pipelines expect, without touching a single coded
 * frame. Video and audio bitstreams are copied byte-for-byte.
 *
 * Three edits, and only three:
 *   1. mvhd.duration -> 0xFF..FF ("unknown duration"), upgrading mvhd v0 -> v1
 *   2. a ©too encoder tag under moov/udta/meta/ilst
 *   3. every stco/co64 chunk offset recomputed for moov's new size
 *
 * Runs in Node and in the browser. No dependencies.
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.MP4Patch = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  var VERSION = '1.0.0'

  /* Boxes whose payload is a list of child boxes. */
  var CONTAINERS = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'ilst']

  /* Atoms that legitimately sit directly inside a `meta` box, whichever flavour
   * of meta it is. Used to disambiguate the two layouts below. */
  var META_CHILDREN = ['hdlr', 'ilst', 'keys', 'dinf', 'free', 'ID32', 'uuid',
    'pitm', 'iloc', 'iinf', 'iprp', 'iref']

  /* ©too — the "encoder" tag iTunes/QuickTime write into metadata. */
  var TOO_TYPE = String.fromCharCode(0xa9) + 'too'

  var DEFAULT_TAG = 'Lavf61.7.100'
  var MAX_TABLE_ENTRIES = 50000000

  /* ---------- byte helpers ---------- */

  function u8(n) { return new Uint8Array([n & 0xff]) }

  function u32(n) {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
  }

  function u64(n) {
    var hi = Math.floor(n / 4294967296), lo = n >>> 0
    var out = new Uint8Array(8)
    out.set(u32(hi), 0)
    out.set(u32(lo), 4)
    return out
  }

  function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
  }

  function readU64(b, o) {
    return readU32(b, o) * 4294967296 + readU32(b, o + 4)
  }

  function strBytes(s) {
    var out = new Uint8Array(s.length)
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
    return out
  }

  function bytesToStr(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])
  }

  function concat(list) {
    var n = 0, i
    for (i = 0; i < list.length; i++) n += list[i].length
    var out = new Uint8Array(n), p = 0
    for (i = 0; i < list.length; i++) { out.set(list[i], p); p += list[i].length }
    return out
  }

  /* Accept anything buffer-like, including buffers from another realm (an
   * iframe, a worker, a VM context) where `instanceof` would not match. */
  function isArrayBuffer(x) {
    return !!x && typeof x === 'object' && typeof x.byteLength === 'number' &&
      Object.prototype.toString.call(x) === '[object ArrayBuffer]'
  }

  function toU8(x) {
    if (ArrayBuffer.isView(x)) {
      return new Uint8Array(x.buffer, x.byteOffset, x.byteLength)
    }
    if (isArrayBuffer(x)) return new Uint8Array(x)
    throw new Error('Expected a Uint8Array or ArrayBuffer.')
  }

  function fail(msg) {
    var e = new Error(msg)
    e.name = 'MP4PatchError'
    throw e
  }

  /* ---------- box model ---------- */

  /* A node is { type, payload, children|null, prefix? }.
   *   children === null -> leaf, payload is the raw box body
   *   children !== null -> container, body is rebuilt from children
   * `prefix` carries a container's leading FullBox bytes (meta has 4). */

  function makeBox(type, payload) { return { type: type, payload: payload, children: null } }

  function makeContainer(type, children, prefix) {
    return { type: type, payload: null, children: children, prefix: prefix || null }
  }

  function serializeNode(node) {
    var typeBytes = typeof node.type === 'string' ? strBytes(node.type) : node.type
    var body

    if (node.children) {
      var parts = node.prefix ? [node.prefix] : []
      for (var i = 0; i < node.children.length; i++) parts.push(serializeNode(node.children[i]))
      body = concat(parts)
    } else {
      body = node.payload
    }

    if (body.length + 8 > 4294967295) fail('A box grew past the 32-bit size limit.')
    return concat([u32(body.length + 8), typeBytes, body])
  }

  /* Scan a byte range into a flat list of boxes. */
  function scanBoxes(buf, start, end, what) {
    var out = [], p = start
    while (p + 8 <= end) {
      var size = readU32(buf, p)
      var type = bytesToStr(buf, p + 4)
      var header = 8

      if (size === 1) {
        if (p + 16 > end) fail('The ' + what + ' is truncated inside a 64-bit box header.')
        size = readU64(buf, p + 8)
        header = 16
      } else if (size === 0) {
        size = end - p
      }

      if (size < header) fail('The ' + what + ' contains a box with an impossible size (' + size + ').')
      if (p + size > end) fail('The ' + what + ' contains a box that runs past its parent.')

      out.push({ type: type, start: p, header: header, end: p + size })
      p += size
    }
    if (p !== end) fail('The ' + what + ' is not a complete box run.')
    return out
  }

  function parseContainer(buf, start, end, what) {
    var flat = scanBoxes(buf, start, end, what)
    var nodes = []

    for (var i = 0; i < flat.length; i++) {
      var b = flat[i]
      var payloadStart = b.start + b.header

      if (CONTAINERS.indexOf(b.type) >= 0) {
        nodes.push(makeContainer(b.type, parseContainer(buf, payloadStart, b.end, b.type)))
      } else if (b.type === 'meta') {
        var m = parseMetaChildren(buf, payloadStart, b.end)
        nodes.push(makeContainer('meta', m.children, m.prefix))
      } else {
        nodes.push(makeBox(b.type, buf.subarray(payloadStart, b.end)))
      }
    }
    return nodes
  }

  function find(list, type) {
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i]
    return null
  }

  /* `meta` is genuinely ambiguous in the wild. ISO/IEC 14496-12 defines it as a
   * FullBox — 4 bytes of version/flags ahead of its children. QuickTime omits
   * that field entirely, and because most phones and Apple-adjacent editors
   * write QuickTime-flavoured atoms, assuming the FullBox layout desynchronises
   * the parse 4 bytes into the first child.
   *
   * There is no flag that distinguishes them, so parse it both ways and keep
   * whichever yields recognisable meta children. A wrong reading either throws
   * or produces junk atom names, so the scoring is decisive in practice. */
  function parseMetaChildren(buf, payloadStart, end) {
    var candidates = []

    for (var a = 0; a < 2; a++) {
      var off = a === 0 ? 4 : 0                 /* try the FullBox reading first */
      var start = payloadStart + off
      if (start + 8 > end) continue
      try {
        var kids = parseContainer(buf, start, end, 'meta')
        var score = 0
        for (var i = 0; i < kids.length; i++) {
          if (META_CHILDREN.indexOf(kids[i].type) >= 0) score++
        }
        candidates.push({ off: off, kids: kids, score: score })
      } catch (e) { /* not this layout */ }
    }

    if (!candidates.length) fail('The meta box could not be parsed.')

    candidates.sort(function (x, y) { return y.score - x.score })
    var best = candidates[0]
    return {
      children: best.kids,
      /* Keep the 4 bytes only when they really are version/flags, so a
       * QuickTime meta round-trips without quietly gaining a field. */
      prefix: best.off === 4 ? buf.subarray(payloadStart, payloadStart + 4) : null
    }
  }

  function findAll(list, type) {
    var out = []
    for (var i = 0; i < list.length; i++) if (list[i].type === type) out.push(list[i])
    return out
  }

  function findStbl(trak) {
    var mdia = find(trak.children, 'mdia'); if (!mdia) return null
    var minf = find(mdia.children, 'minf'); if (!minf) return null
    return find(minf.children, 'stbl')
  }

  /* ---------- sample tables ---------- */

  function entryCount(payload, width, name) {
    if (!payload || payload.length < 8) fail('The ' + name + ' table is truncated.')
    var n = readU32(payload, 4)
    if (n > MAX_TABLE_ENTRIES) fail('The ' + name + ' table is unreasonably large (' + n + ' entries).')
    if (8 + n * width > payload.length) fail('The ' + name + ' table is truncated.')
    return n
  }

  function readStsz(payload) {
    if (!payload || payload.length < 12) fail('The stsz table is truncated.')
    var uniform = readU32(payload, 4)
    var count = readU32(payload, 8)
    if (count > MAX_TABLE_ENTRIES) fail('The stsz table is unreasonably large (' + count + ' entries).')

    if (uniform !== 0) {
      var all = new Array(count)
      for (var k = 0; k < count; k++) all[k] = uniform
      return all
    }
    if (12 + count * 4 > payload.length) fail('The stsz table is truncated.')
    var sizes = new Array(count)
    for (var i = 0; i < count; i++) sizes[i] = readU32(payload, 12 + i * 4)
    return sizes
  }

  /* stsc: [first_chunk, samples_per_chunk, sample_description_index] */
  function readStsc(payload) {
    var n = entryCount(payload, 12, 'stsc'), runs = []
    for (var i = 0; i < n; i++) {
      var o = 8 + i * 12
      runs.push([readU32(payload, o), readU32(payload, o + 4), readU32(payload, o + 8)])
    }
    return runs
  }

  /* stts: [sample_count, sample_delta] */
  function readStts(payload) {
    var n = entryCount(payload, 8, 'stts'), runs = []
    for (var i = 0; i < n; i++) {
      runs.push([readU32(payload, 8 + i * 8), readU32(payload, 12 + i * 8)])
    }
    return runs
  }

  function readChunkOffsets(node) {
    var w = node.type === 'co64' ? 8 : 4
    var n = entryCount(node.payload, w, node.type), out = new Array(n)
    for (var i = 0; i < n; i++) {
      out[i] = w === 8 ? readU64(node.payload, 8 + i * 8) : readU32(node.payload, 8 + i * 4)
    }
    return out
  }

  function writeChunkOffsets(node, offsets) {
    var need64 = false
    for (var i = 0; i < offsets.length; i++) if (offsets[i] > 4294967295) { need64 = true; break }

    var type = need64 ? 'co64' : 'stco'
    var w = need64 ? 8 : 4
    var buf = new Uint8Array(8 + offsets.length * w)
    buf.set(node.payload.subarray(0, 4), 0)          /* preserve version/flags */
    buf.set(u32(offsets.length), 4)
    for (var j = 0; j < offsets.length; j++) {
      buf.set(need64 ? u64(offsets[j]) : u32(offsets[j]), 8 + j * w)
    }
    return { type: type, payload: buf }
  }

  function readStsdEntryCount(trak) {
    var stbl = findStbl(trak); if (!stbl) return -1
    var stsd = find(stbl.children, 'stsd'); if (!stsd) return -1
    return readU32(stsd.payload, 4)
  }

  function readStsdCodec(trak) {
    var stbl = findStbl(trak); if (!stbl) return ''
    var stsd = find(stbl.children, 'stsd')
    if (!stsd || stsd.payload.length < 16) return ''
    return bytesToStr(stsd.payload, 12)            /* first entry type */
  }

  function readHandlerType(trak) {
    var mdia = find(trak.children, 'mdia'); if (!mdia) return ''
    var hdlr = find(mdia.children, 'hdlr'); if (!hdlr) return ''
    if (hdlr.payload.length < 12) fail('The hdlr box is truncated.')
    return bytesToStr(hdlr.payload, 8)
  }

  /* ---------- track analysis ---------- */

  /* Expand stsz/stsc/stts/stco into per-sample sizes and absolute offsets.
   * Returns null when the tables disagree — which is the real reason most
   * editor exports are rejected. */
  function analyzeTrack(trak) {
    var stbl = findStbl(trak); if (!stbl) return null

    var stszNode = find(stbl.children, 'stsz')
    var stscNode = find(stbl.children, 'stsc')
    var sttsNode = find(stbl.children, 'stts')
    var offsNode = find(stbl.children, 'stco') || find(stbl.children, 'co64')

    if (!stszNode || !stscNode || !sttsNode || !offsNode) return null

    var sizes, offsets, runs
    try {
      sizes = readStsz(stszNode.payload)
      offsets = readChunkOffsets(offsNode)
      runs = readStsc(stscNode.payload)
    } catch (e) { return null }

    var count = sizes.length
    if (!count || !offsets.length || !runs.length) return null

    /* Walk stsc runs out to one samples-per-chunk value per chunk. */
    var perChunk = []
    for (var i = 0; i < runs.length; i++) {
      var first = runs[i][0], per = runs[i][1]
      /* run[2] is the sample_description_index; multi-description tracks are
       * already rejected in parseFile. */
      if (first < 1) return null
      var last = i + 1 < runs.length ? runs[i + 1][0] - 1 : offsets.length
      if (first > last || last > offsets.length) return null
      for (var c = first; c <= last; c++) perChunk.push(per)
    }

    if (perChunk.length !== offsets.length) return null

    var total = 0
    for (var t = 0; t < perChunk.length; t++) total += perChunk[t]
    if (total !== count) return null

    var abs = new Array(count), k = 0
    for (var ci = 0; ci < offsets.length; ci++) {
      var pos = offsets[ci]
      for (var s = 0; s < perChunk[ci]; s++) { abs[k] = pos; pos += sizes[k]; k++ }
    }

    var dur = 0, stts
    try { stts = readStts(sttsNode.payload) } catch (e) { return null }
    for (var d = 0; d < stts.length; d++) dur += stts[d][0]
    if (dur !== count) return null

    return {
      trak: trak, stszNode: stszNode, offsNode: offsNode,
      sizes: sizes, offsets: abs, runs: runs, count: count,
      handler: readHandlerType(trak), codec: readStsdCodec(trak)
    }
  }

  /* ---------- the three edits ---------- */

  function isUnknownDuration(payload) {
    if (!payload || payload.length < 0x20 || payload[0] !== 1) return false
    for (var i = 0; i < 8; i++) if (payload[0x18 + i] !== 0xff) return false
    return true
  }

  /* mvhd carries the movie duration the whole file is trusted for. Setting it
   * to the all-ones sentinel is what a live-captured stream looks like, and it
   * stops ingest from treating the file as a fixed-length asset to normalise. */
  function patchMvhd(payload) {
    if (!payload || payload.length < 4) fail('Malformed mvhd box.')
    var version = payload[0]

    if (version === 1) {
      if (payload.length < 0x70) fail('Malformed version-1 mvhd box.')
      var out = payload.slice()
      for (var i = 0; i < 8; i++) out[0x18 + i] = 0xff
      return out
    }
    if (version !== 0) fail('Unsupported mvhd version: ' + version + '.')
    if (payload.length < 0x64) fail('Malformed version-0 mvhd box.')

    /* v0 -> v1: creation/modification/duration widen from 32 to 64 bits. */
    return concat([
      u8(1), payload.subarray(1, 4),
      u32(0), payload.subarray(4, 8),
      u32(0), payload.subarray(8, 12),
      payload.subarray(12, 16),
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      payload.subarray(0x14, 0x64)
    ])
  }

  function makeEncoderAtom(tagBytes) {
    var dataPayload = concat([u32(1), u32(0), tagBytes])   /* UTF-8, locale 0 */
    return makeBox(TOO_TYPE, concat([u32(dataPayload.length + 8), strBytes('data'), dataPayload]))
  }

  function makeMetaBox(tagBytes) {
    var hdlrPayload = concat([u32(0), u32(0), strBytes('mdir'), new Uint8Array(12), new Uint8Array(1)])
    var ilst = makeContainer('ilst', [makeEncoderAtom(tagBytes)])
    var hdlr = makeBox('hdlr', hdlrPayload)
    return makeContainer('meta', [hdlr, ilst], u32(0))
  }



  /* Replace any existing encoder tag in place rather than appending a second
   * one, so other ilst metadata (title, artist) survives and the file does not
   * grow a duplicate ©too atom on every run. */
  function ensureEncoderTag(moov, tagBytes) {
    var atom = makeEncoderAtom(tagBytes)

    var udta = find(moov.children, 'udta')
    if (!udta) {
      moov.children.push(makeContainer('udta', [makeMetaBox(tagBytes)]))
      return
    }
    if (!udta.children) {
      /* A raw udta we cannot safely extend — replace it wholesale. */
      moov.children[moov.children.indexOf(udta)] =
        makeContainer('udta', [makeMetaBox(tagBytes)])
      return
    }

    var meta = find(udta.children, 'meta')
    if (!meta) { udta.children.push(makeMetaBox(tagBytes)); return }

    if (!meta.children) meta.children = []
    var ilst = find(meta.children, 'ilst')
    if (!ilst) { meta.children.push(makeContainer('ilst', [atom])); return }

    if (!ilst.children) ilst.children = []
    var existing = find(ilst.children, TOO_TYPE)
    if (existing) ilst.children[ilst.children.indexOf(existing)] = atom
    else ilst.children.push(atom)
  }

  /* ---------- faststart ---------- */

  /* MOV files carry their own brand; relabel to MP4 so ingest treats them as
   * MP4. Nothing inside is re-coded — only the ftyp signature changes. */
  function relabelFtyp(node, report) {
    if (!node || node.payload.length < 8) return
    var major = bytesToStr(node.payload, 0)
    if (major !== 'qt  ') return
    var compatible = ['isom', 'iso2', 'mp41', 'mp42', 'avc1']
    var parts = [strBytes('mp42')]
    parts.push(u32(512))
    for (var i = 0; i < compatible.length; i++) parts.push(strBytes(compatible[i]))
    node.payload = concat(parts)
    report.remuxed = true
  }

  /* ---------- main ---------- */

  function parseFile(buf, opts) {
    if (!buf.length) fail('Invalid MP4 — the file is empty.')
    opts = opts || {}

    var top = scanBoxes(buf, 0, buf.length, 'top-level')

    for (var i = 0; i < top.length; i++) {
      if (top[i].type === 'moof') fail('Fragmented MP4/MOV files are not supported.')
    }

    var ftypBox = null, moovBox = null, mdatBox = null
    for (var j = 0; j < top.length; j++) {
      if (top[j].type === 'ftyp' && !ftypBox) ftypBox = top[j]
      if (top[j].type === 'moov' && !moovBox) moovBox = top[j]
      if (top[j].type === 'mdat' && !mdatBox) mdatBox = top[j]
    }

    if (!ftypBox || !moovBox || !mdatBox) {
      fail('Invalid MP4 — expected exactly one ftyp, moov and mdat box (found ' +
        (ftypBox ? 1 : 0) + '/' + (moovBox ? 1 : 0) + '/' + (mdatBox ? 1 : 0) + ').')
    }

    var moov = makeContainer('moov', parseContainer(buf, moovBox.start + moovBox.header, moovBox.end, 'moov'))
    var traks = findAll(moov.children, 'trak')
    if (!traks.length) fail('Invalid MP4 — no tracks were found.')

    var mvhd = find(moov.children, 'mvhd')
    if (!mvhd || mvhd.payload.length < 4) fail('Invalid MP4 — missing mvhd.')
    if (!opts.allowPatched && isUnknownDuration(mvhd.payload)) {
      fail('This file is already patched (the mvhd duration sentinel is present).')
    }
    if (mvhd.payload[0] !== 0 && mvhd.payload[0] !== 1) {
      fail('Unsupported mvhd version: ' + mvhd.payload[0] + '.')
    }

    var tables = traks.map(analyzeTrack)
    for (var k = 0; k < tables.length; k++) {
      if (!tables[k]) {
        fail('Could not map the sample tables of every track. This usually means a ' +
          'variable-frame-rate or otherwise inconsistent export — re-export at a ' +
          'constant frame rate and try again.')
      }
    }

    for (var t = 0; t < tables.length; t++) {
      if (readStsdEntryCount(tables[t].trak) !== 1) {
        fail('Tracks with multiple codec descriptions are not supported.')
      }
      for (var r = 0; r < tables[t].runs.length; r++) {
        if (tables[t].runs[r][2] !== 1) {
          fail('Tracks with multiple codec descriptions are not supported.')
        }
      }
    }

    var videoTracks = tables.filter(function (x) { return x.handler === 'vide' })
    if (videoTracks.length !== 1) {
      fail('Expected exactly one video track, found ' + videoTracks.length + '.')
    }
    var video = videoTracks[0]
    var isAvc = video.codec === 'avc1' || video.codec === 'avc3'
    var isHevc = video.codec === 'hvc1' || video.codec === 'hev1' || video.codec === 'hvc2' || video.codec === 'hev2'
    if (!isAvc && !isHevc) {
      fail('Unsupported video codec: ' + (video.codec || 'unknown') + '. Export as H.264/AVC or HEVC/H.265.')
    }

    var audioTracks = tables.filter(function (x) { return x.handler === 'soun' })
    var aac = audioTracks.filter(function (x) { return x.codec === 'mp4a' })
    if (!aac.length) fail('This video needs an AAC audio track to be patched.')

    /* Every sample must land inside the single mdat. */
    var mdatStart = mdatBox.start + mdatBox.header
    for (var q = 0; q < tables.length; q++) {
      var tb = tables[q]
      if (tb.offsets.length !== tb.sizes.length) fail('A track\'s sample tables disagree in length.')
      for (var s = 0; s < tb.count; s++) {
        var off = tb.offsets[s], size = tb.sizes[s]
        if (!isFinite(off) || !isFinite(size) || size < 0 ||
            off < mdatStart || off + size > mdatBox.end) {
          fail('Track sample ' + (s + 1) + ' points outside the single media-data box.')
        }
      }
    }

    return {
      buf: buf, top: top, ftypBox: ftypBox, moovBox: moovBox, mdatBox: mdatBox,
      moov: moov, mvhd: mvhd, traks: traks, tables: tables,
      video: video, audio: aac[0], isAvc: isAvc, isHevc: isHevc
    }
  }

  function applyPatch(parsed, options) {
    options = options || {}
    var tag = options.tag === undefined ? DEFAULT_TAG : options.tag
    var faststart = !!options.faststart
    var buf = parsed.buf
    var report = { remuxed: false, shifted: 0, tag: tag || null }

    /* --- edit 1: mvhd duration sentinel --- */
    parsed.mvhd.payload = patchMvhd(parsed.mvhd.payload)

    /* --- edit 2: encoder tag --- */
    if (tag) ensureEncoderTag(parsed.moov, strBytes(tag))

    /* --- relabel MOV if asked --- */
    var ftypNode = null
    for (var f = 0; f < parsed.top.length; f++) {
      if (parsed.top[f].type === 'ftyp') {
        ftypNode = makeBox('ftyp', buf.subarray(parsed.top[f].start + parsed.top[f].header, parsed.top[f].end))
      }
    }
    relabelFtyp(ftypNode, report)

    /* --- work out the new top-level order --- */
    var originalMoovSize = parsed.moovBox.end - parsed.moovBox.start
    var mdatOldStart = parsed.mdatBox.start + parsed.mdatBox.header

    /* Build the emit order from the original top level, substituting the
     * rebuilt moov in place, then reposition it if faststart was asked for. */
    var order = [], ftypIdx = -1
    for (var i = 0; i < parsed.top.length; i++) {
      var b = parsed.top[i]
      if (b.type === 'moov') { order.push({ kind: 'moov' }); continue }
      if (b.type === 'mdat') { order.push({ kind: 'mdat' }); continue }
      if (b.type === 'ftyp') ftypIdx = order.length
      order.push({
        kind: 'raw',
        bytes: (b.type === 'ftyp' && ftypNode) ? serializeNode(ftypNode) : buf.subarray(b.start, b.end)
      })
    }

    if (faststart) {
      var mi = -1
      for (var q = 0; q < order.length; q++) if (order[q].kind === 'moov') { mi = q; break }
      if (mi > ftypIdx) {
        var moved = order.splice(mi, 1)[0]
        order.splice(ftypIdx + 1, 0, moved)
      }
    }

    var traksWithOffsets = []
    var originalOffsets = []
    for (var w = 0; w < parsed.tables.length; w++) {
      var node = parsed.tables[w].offsNode
      if (node) {
        traksWithOffsets.push(node)
        originalOffsets.push(readChunkOffsets(node))
      }
    }

    /* moov changes size as we patch, and an stco->co64 promotion changes it
     * again, so converge: probe the size, shift the offsets, re-serialize, and
     * repeat until the size stops moving. moovBytes is only ever read after a
     * pass whose size matched the probe the shift was computed from. */
    var moovBytes = null, shift = 0

    function mdatStartFor(size) {
      var cursor = 0
      for (var p = 0; p < order.length; p++) {
        if (order[p].kind === 'moov') { cursor += size; continue }
        /* + the mdat's own header length, which is 16 — not 8 — when the box
         * carries a 64-bit size (size == 1 + largesize). Phones write that
         * routinely so the box can grow past 4 GB, and assuming 8 here puts
         * every chunk offset 8 bytes low. */
        if (order[p].kind === 'mdat') return cursor + parsed.mdatBox.header
        cursor += order[p].bytes.length
      }
      return -1
    }

    for (var pass = 0; pass < 4; pass++) {
      var probe = serializeNode(parsed.moov)
      shift = mdatStartFor(probe.length) - mdatOldStart

      for (var x = 0; x < traksWithOffsets.length; x++) {
        var res = writeChunkOffsets(traksWithOffsets[x],
          originalOffsets[x].map(function (v) { return v + shift }))
        traksWithOffsets[x].type = res.type
        traksWithOffsets[x].payload = res.payload
      }

      moovBytes = serializeNode(parsed.moov)
      if (moovBytes.length === probe.length) break
    }

    report.shifted = shift
    report.moovGrew = moovBytes.length - originalMoovSize
    report.originalMoovSize = originalMoovSize

    /* --- rebuild the file from the new order --- */
    var finalMoov = moovBytes
    var out = []
    for (var r = 0; r < order.length; r++) {
      if (order[r].kind === 'moov') out.push(finalMoov)
      else if (order[r].kind === 'mdat') {
        out.push(buf.subarray(parsed.mdatBox.start, parsed.mdatBox.end))
      } else out.push(order[r].bytes)
    }

    var result = concat(out)
    validatePatchedOutput(result)
    return { data: result, report: report }
  }

  function validatePatchedOutput(out) {
    var top = scanBoxes(out, 0, out.length, 'patched output')

    var moovs = top.filter(function (b) { return b.type === 'moov' })
    var mdats = top.filter(function (b) { return b.type === 'mdat' })
    if (moovs.length !== 1 || mdats.length !== 1) {
      fail('Patched output must contain exactly one moov and one mdat.')
    }

    var moovBox = moovs[0], mdatBox = mdats[0]
    var mdatStart = mdatBox.start + mdatBox.header

    var moov = makeContainer('moov', parseContainer(out, moovBox.start + moovBox.header, moovBox.end, 'moov'))

    var mvhd = find(moov.children, 'mvhd')
    if (!mvhd || !isUnknownDuration(mvhd.payload)) {
      fail('Patched output mvhd.duration is not the unknown sentinel.')
    }

    var traks = findAll(moov.children, 'trak')
    for (var i = 0; i < traks.length; i++) {
      var stbl = findStbl(traks[i]); if (!stbl) continue
      var node = find(stbl.children, 'stco') || find(stbl.children, 'co64')
      if (!node) continue
      var offs = readChunkOffsets(node)
      for (var j = 0; j < offs.length; j++) {
        if (offs[j] < mdatStart || offs[j] >= mdatBox.end) {
          fail('A patched chunk offset (' + offs[j] + ') points outside the media data. ' +
            'Aborting to avoid writing a corrupt file.')
        }
      }
    }
  }

  function quickPatch(input, options) {
    var buf = toU8(input)
    var parsed = parseFile(buf)
    return applyPatch(parsed, options)
  }

  function inspect(input) {
    var buf = toU8(input)
    var parsed = parseFile(buf, { allowPatched: true })
    return describe(parsed.buf, parsed)
  }

  function checkCompatibility(input) {
    try {
      var parsed = parseFile(toU8(input), { allowPatched: true })
      return {
        compatible: true, reason: '',
        codec: parsed.video.codec,
        isAvc: parsed.isAvc, isHevc: parsed.isHevc,
        sampleCount: parsed.video.count,
        audioCodec: parsed.audio.codec,
        audioTrackCount: parsed.tables.filter(function (t) { return t.handler === 'soun' }).length
      }
    } catch (e) {
      return {
        compatible: false,
        reason: e && e.message ? e.message : 'The MP4/MOV structure is not supported.',
        codec: '', isAvc: false, isHevc: false, sampleCount: 0,
        audioCodec: '', audioTrackCount: 0
      }
    }
  }

  function describe(buf, parsed) {
    var mvhd = parsed.mvhd.payload
    var timescale, duration, version = mvhd[0]
    if (version === 1) {
      timescale = readU32(mvhd, 20)
      duration = readU64(mvhd, 24)
    } else {
      timescale = readU32(mvhd, 12)
      duration = readU32(mvhd, 16)
    }
    var seconds = timescale ? duration / timescale : 0

    return {
      containerBrand: bytesToStr(parsed.buf, parsed.ftypBox.start + parsed.ftypBox.header),
      moovBeforeMdat: parsed.moovBox.start < parsed.mdatBox.start,
      mvhdVersion: version,
      alreadyPatched: isUnknownDuration(mvhd),
      durationSeconds: seconds,
      video: {
        codec: parsed.video.codec,
        sampleCount: parsed.video.count,
        width: readU32(parsed.video.trak.children ? findTrakField(parsed.video.trak, 76) : null, 0) || null
      },
      audio: { codec: parsed.audio.codec, sampleCount: parsed.audio.count },
      tracks: parsed.tables.map(function (t) {
        return { handler: t.handler, codec: t.codec, samples: t.count }
      })
    }
  }

  /* tkhd width lives at a fixed offset; not worth a full parse. */
  function findTrakField(trak, offset) { return null }

  /* Expose a light structural dump for the CLI's --inspect. */
  function inspectTracks(input) {
    var buf = toU8(input)
    var parsed = parseFile(buf, { allowPatched: true })

    function trackInfo(t) {
      var info = {
        handler: t.handler, codec: t.codec, samples: t.count,
        samplesPerChunk: t.runs.length ? t.runs[0][1] : null,
        stscRunCount: t.runs.length
      }
      var sttsNode = find(findStbl(t.trak).children, 'stts')
      var stts = readStts(sttsNode.payload)
      var deltas = {}
      for (var i = 0; i < stts.length; i++) {
        if (stts[i][1] !== 0) deltas[stts[i][1]] = (deltas[stts[i][1]] || 0) + stts[i][0]
      }
      var keys = Object.keys(deltas)
      info.constantFrameRate = keys.length <= 1
      info.sttsRunCount = stts.length
      return info
    }

    var timescale, duration, mvhd = parsed.mvhd.payload
    if (mvhd[0] === 1) { timescale = readU32(mvhd, 20); duration = readU64(mvhd, 24) }
    else { timescale = readU32(mvhd, 12); duration = readU32(mvhd, 16) }

    var out = {
      brand: bytesToStr(buf, parsed.ftypBox.start + parsed.ftypBox.header),
      fileSize: buf.length,
      moovBeforeMdat: parsed.moovBox.start < parsed.mdatBox.start,
      mvhdVersion: mvhd[0],
      timescale: timescale,
      durationSeconds: timescale ? duration / timescale : 0,
      alreadyPatched: isUnknownDuration(mvhd),
      videoCodec: parsed.video.codec,
      tracks: parsed.tables.map(trackInfo)
    }
    return out
  }

  return {
    VERSION: VERSION,
    DEFAULT_TAG: DEFAULT_TAG,
    quickPatch: quickPatch,
    inspect: inspectTracks,
    checkCompatibility: checkCompatibility
  }
})
