# MP4 Optimizer

A local, offline build of the "TikTok video optimizer" pattern: it rewrites an
MP4/MOV **container** so ingest pipelines see the shape they expect, while
copying every coded frame and audio sample through untouched.

Nothing is uploaded. There is no server, no login, no size cap, and no
re-encoding — the whole thing is under 800 lines of dependency-free JavaScript
that runs in a browser tab or from a terminal.

---

## Quick start

**Browser** — open `index.html`. Drag a video in, get a patched one back.
Works offline; the file never leaves the machine.

**No server needed.** Double-click `index.html` and it runs from `file://`.
There is no `fetch`, no `XMLHttpRequest`, no ES module, and no external URL in
either file, which is what `file://` actually blocks. Both halves were checked
against headless Chrome rather than assumed:

- `engine.js` loads from `file://` (the inline script resolves `MP4Patch` and
  stamps its version into the page).
- A blob-URL `<a download>` still saves a file when the page is on `file://`
  (the blob gets a `null` origin, and the download completes). Re-check with
  `node test/file-download-check.mjs` — it drives a real mouse click through
  CDP, because Chrome ignores the `download` attribute on a programmatic
  `.click()`, which is why a naive test reports a false failure.

If your browser ever does block the save, serve the folder instead:
`py -m http.server 8000 --directory .` and open `http://127.0.0.1:8000/`.

### Saving large files

Files at or above **128 MB** stream straight to disk through
`showSaveFilePicker` instead of being held in memory behind a download link.
Because the output parts are mostly views onto the input, nothing is
materialised: peak memory is roughly the input alone, so a 4K capture far larger
than a tab's allocation budget still works. Override the threshold before the
page script runs with `window.MP4_STREAM_THRESHOLD = <bytes>` — `0` streams
everything.

Cancel the picker and it falls back to the normal in-memory download, patched
and untouched. Both outcomes are covered by `test/stream-save-check.mjs`.

Two things checked rather than assumed:

- **OPFS is blocked on `file://`** ("unsafe for access within a Web
  application"), which is why the test falls back to a recording stub and says
  so. The stub still exercises the real write loop — one `write()` per part in
  order, then `close()` — and the result is compared by SHA-256 against the
  engine's own output.
- **`showSaveFilePicker` is not blocked on `file://`.** Called from a real mouse
  click it reaches the dialog stage and fails only with `AbortError`, identical
  to `http://`, because headless Chrome cannot display a native picker. A
  `SecurityError` would have meant the origin was refused; there wasn't one.

**Command line**

```bash
node patch.js video.mp4                     # -> video.optimized.mp4
node patch.js video.mp4 -o out.mp4
node patch.js *.mp4 --outdir out/           # batch
node patch.js video.mp4 --inspect           # report only, writes nothing
node patch.js video.mp4 --faststart         # move moov ahead of mdat
node patch.js video.mp4 --tag "SomeEncoder 1.0"
node patch.js video.mp4 --no-tag
```

`--inspect` works on already-patched files too, so you can verify your output.

---

## What it actually does

Three edits, and only three. Everything else in the file is byte-identical.

**1. `mvhd` duration → unknown sentinel.** The movie header's duration is
overwritten with all-ones (`0xFFFF…`), which is what a live-captured stream
looks like. This widens the box from version 0 to version 1, so `moov` grows by
12 bytes.

**2. A `©too` encoder tag** is written under `moov/udta/meta/ilst`. If the file
already has one (ffmpeg writes `Lavf…` by default) it is **replaced in place**
rather than duplicated, so other `ilst` metadata survives.

**3. Every `stco`/`co64` chunk offset is recomputed.** Edit 1 and 2 change
`moov`'s size; if `moov` sits before `mdat` (faststart), every chunk pointer in
the file moves by the same delta. The offsets are rewritten to match, and an
`stco` is promoted to `co64` if any offset crosses 4 GB.

Before any of that, the sample tables (`stsz`, `stsc`, `stts`, `stco`) are
expanded into per-sample sizes and absolute offsets and checked against each
other. If they disagree, the file is **rejected** rather than written out
corrupt. After patching, the output is re-parsed and every chunk offset is
checked to land inside `mdat`.

### What it does *not* do

Some tools in this space advertise "fake sample injection", "inflating sample
counts to 400 FPS", or rewriting edit lists and sync-sample tables. This one
does none of that, and neither does the engine it was modelled on — its
published patcher touches only `mvhd`, `udta`, and the offset tables.

The "must be constant frame rate" advice you'll see is really just this: a
variable-frame-rate export frequently has inconsistent sample tables, and that
is what makes it unparseable. There is no FPS manipulation here.

---

## Verifying it yourself

The claim is "zero quality loss". That is testable — hash the elementary
streams before and after:

```bash
ffmpeg -i in.mp4  -map 0:v -c copy -f md5 -
ffmpeg -i out.mp4 -map 0:v -c copy -f md5 -      # must match
```

On the bundled fixtures all four pass: video and audio MD5s are identical, and
the outputs decode without errors.

```
node patch.js test/source.mp4 --force
node test/ui-test.js          # 32 assertions over the browser code path
```

### The two shapes of `meta`

`moov/udta/meta` is ambiguous in the wild and there is no flag that says which
you have:

- **ISO** (ISO/IEC 14496-12) — a FullBox, so 4 bytes of version/flags precede
  its children. This is what ffmpeg writes.
- **QuickTime** — no version/flags field; children start immediately. This is
  what phones and Apple-adjacent editors write, and it is common even in `.mp4`.

Assuming either one desynchronises the parse 4 bytes into the first child, which
surfaces as `The meta contains a box that runs past its parent`. So the parser
reads it **both ways** and keeps whichever yields recognisable meta children
(`hdlr`, `ilst`, `keys`, …) — a wrong reading either throws or produces junk atom
names, so the scoring is decisive. The layout is then preserved on the way out:
a QuickTime `meta` does not quietly gain a version/flags field.

`test/meta_qt.mp4` is a QuickTime-shaped fixture (built by `test/make-qt-meta.py`)
and `test/meta_iso.mp4` the ISO one; both are in the test suite.

### 64-bit box headers

A box's size field is 32 bits, so to exceed 4 GB MP4 defines an escape: size
`1`, followed by a 64-bit `largesize`, making the header 16 bytes instead of 8.
**Phones write `mdat` this way routinely**, not only when the file is actually
large — which means the header length cannot be assumed.

Assuming 8 puts every chunk offset exactly 8 bytes low, and the symptom is a
patch that computes cleanly and then fails validation with
`A patched chunk offset (N) points outside the media data` where N is 8 short of
the real value. Anything that walks the top level must use each box's own header
length. `test/mdat64.mp4` is the fixture (built by `test/make-mdat64.py`); it is
in the test suite, and the 64-bit header is preserved in the output.

Related: the 32-bit `stco` offset table is promoted to 64-bit `co64`
automatically if any rewritten offset crosses 4 GB.

---

## On a phone

`index.html` is static, so GitHub Pages serves it as-is (`https`, which is a
secure context — needed for both `showSaveFilePicker` and the share sheet). The
layout was checked at 320, 360 and 390 px wide, and tapping the drop zone,
picking a file and patching all work at those sizes.

The two platforms are **not** equivalent, though:

| | Android Chrome | iOS (Safari *and* Chrome) |
|---|---|---|
| Patch | works | works |
| `showSaveFilePicker` (stream to disk) | yes | **no** |
| Saving | Downloads | Files |
| Share sheet → Photos | yes | yes |

**Chrome on iOS is not Chrome.** Apple requires every iOS browser to use WebKit,
so Chrome there is Safari underneath and has Safari's limits. MDN lists
`showSaveFilePicker` as *"Safari on iOS: No support"*, and that applies to Chrome
on iOS too — so iOS always falls back to the in-memory blob path. That makes
memory the real constraint there: a phone tab's budget is far smaller than a
desktop's, so keep files modest on iOS and prefer the CLI for anything long.

**Getting the file into Photos on iOS** is the awkward part — a blob
`<a download>` lands in Files, not the camera roll. The **Share** button is the
route: it hands the patched file to the iOS share sheet, which can save it to
Photos or straight into another app. It is feature-detected with
`navigator.canShare({ files: [...] })`, so it only appears where sharing files
actually works, and it cannot misfire on a desktop.

`test/mobile-check.mjs` covers the layout and flow, and
`test/stream-save-check.mjs <fixture> share` covers the share path. Note that
both drive desktop Chrome with mobile metrics — that catches layout and flow
problems, but it is **not WebKit**, so iOS behaviour remains inferred from the
documented support rather than observed.

---

## Supported

| | |
|---|---|
| Containers | MP4, MOV (MOV is relabelled `qt  ` → `mp42`) |
| Video | H.264/AVC (`avc1`, `avc3`), HEVC/H.265 (`hvc1`, `hev1`, `hvc2`, `hev2`) |
| Audio | AAC (`mp4a`), at least one track |
| Structure | exactly one `ftyp`, `moov`, `mdat`; one video track; constant frame rate; single codec description per track |

Refused, with a reason: fragmented MP4 (`moof`), AV1/VP9/other codecs, silent
videos, PCM audio, files whose sample tables disagree, and files that are
already patched.

---

## The encoder tag

The engine's tag is configurable and defaults to `Lavf61.7.100` (ffmpeg's own
signature — a neutral "professionally muxed" value).

Worth knowing: the hosted tool this was modelled on writes **its own URL** as
the tag (`Zilem Method https://zilemmethod.com`). That value is its branding and
its marker for "already patched", not a codec parameter — so it is not
reproduced here. If the exact string matters for your case, set it with
`--tag`, or in `index.html` where `TAG` is defined.

---

## Honest caveats

- **Whether this beats a platform's re-compression is an empirical claim, not a
  proven one.** The container edit is real and verifiable; the effect on any
  given platform's ingest pipeline is not something this repo can establish. It
  is worth testing against a control rather than assuming the mechanism works.
- **Upload path matters more than the patch.** The hosted tool's own guide says
  uploading through the mobile app re-compresses on the way up, which defeats
  the point — it recommends the desktop web uploader instead. That advice is
  independent of anything this code does.
- The original is never modified; output is a new file. Keep the original until
  you have confirmed the patched file behaves.
- `--faststart` reorders `moov` ahead of `mdat`. It is off by default (matching
  the reference engine) and is a genuine, standard improvement when you want it.

---

## Files

| | |
|---|---|
| `engine.js` | the patcher — MP4 box parser, three edits, validation. Node + browser |
| `index.html` | offline drag-and-drop UI, single file |
| `patch.js` | CLI: batch, inspect, tagging, faststart |
| `test/ui-test.js` | drives the UI's real code path against a stubbed DOM |
| `test/file-download-check.mjs` | proves blob downloads save over `file://` (needs Chrome) |
| `test/stream-save-check.mjs` | exercises the streaming save and its cancel fallback (needs Chrome) |
| `test/mem-bench.js` | peak-memory ratios for the parts vs concat output shapes |
| `test/*.mp4`, `test/*.mov` | generated fixtures (H.264 faststart / non-faststart, HEVC, MOV, fragmented, VP9) |

No dependencies. Node 18+ for the CLI; any modern browser for the UI.

### Regenerating the fixtures

```bash
cd test
ffmpeg -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 \
       -f lavfi -i sine=frequency=440:duration=3 \
       -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart source.mp4
```
