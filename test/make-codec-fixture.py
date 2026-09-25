"""
Rewrite the video track's sample-entry fourcc inside stsd, producing a file with
the container structure of Dolby Vision (or any other codec tag) from an
existing one.

The patch never touches the video description, so a `dvh1` file is structurally
an `hvc1` file with a different four-char tag — which is exactly what this
produces. Fourccs change in place, so no offsets move.

  py test/make-codec-fixture.py test/hevc.mp4 test/dv_hevc.mp4 dvh1
  py test/make-codec-fixture.py test/source.mp4 test/dv_avc.mp4 dvav
"""
import struct
import sys

CONTAINERS = {b'moov', b'trak', b'mdia', b'minf', b'stbl'}


def scan(d, start, end):
    out, p = [], start
    while p + 8 <= end:
        sz = struct.unpack('>I', d[p:p + 4])[0]
        ty = d[p + 4:p + 8]
        h = 8
        if sz == 1:
            sz = struct.unpack('>Q', d[p + 8:p + 16])[0]
            h = 16
        elif sz == 0:
            sz = end - p
        if sz < h or p + sz > end:
            break
        out.append((ty, p, p + h, p + sz))
        p += sz
    return out


def find(d, start, end, name):
    for b in scan(d, start, end):
        if b[0] == name:
            return b
    return None


def main(src, dst, fourcc):
    if len(fourcc) != 4:
        raise SystemExit('fourcc must be exactly 4 characters')

    d = bytearray(open(src, 'rb').read())

    moov = find(d, 0, len(d), b'moov')
    if not moov:
        raise SystemExit('no moov')

    found = None
    for trak in [b for b in scan(d, moov[2], moov[3]) if b[0] == b'trak']:
        mdia = find(d, trak[2], trak[3], b'mdia')
        if not mdia:
            continue
        hdlr = find(d, mdia[2], mdia[3], b'hdlr')
        if not hdlr or d[hdlr[2] + 8:hdlr[2] + 12] != b'vide':
            continue
        minf = find(d, mdia[2], mdia[3], b'minf')
        if not minf:
            continue
        stbl = find(d, minf[2], minf[3], b'stbl')
        if not stbl:
            continue
        stsd = find(d, stbl[2], stbl[3], b'stsd')
        if not stsd:
            continue
        # stsd payload: version/flags(4) entry_count(4) then entry size(4) type(4)
        # so the entry's fourcc sits at payload + 12.
        found = stsd[2] + 12
        break

    if found is None:
        raise SystemExit('no video stsd found')

    old = bytes(d[found:found + 4]).decode('latin1')
    d[found:found + 4] = fourcc.encode('latin1')

    open(dst, 'wb').write(bytes(d))
    print(f'{dst}: video sample entry {old!r} -> {fourcc!r} (same size, offsets untouched)')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
