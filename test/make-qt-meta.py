"""
Synthesise a QuickTime-style `moov/udta/meta` (no version/flags field) inside an
otherwise normal faststart MP4, so the patcher can be exercised against the
shape phones and Apple-adjacent editors actually write.

  py test/make-qt-meta.py test/source.mp4 test/meta_qt.mp4
"""
import struct
import sys


def box(ty, payload):
    return struct.pack('>I', len(payload) + 8) + ty.encode('latin1') + payload


def scan(d, start, end):
    out, p = [], start
    while p + 8 <= end:
        sz = struct.unpack('>I', d[p:p + 4])[0]
        ty = d[p + 4:p + 8].decode('latin1')
        if sz < 8 or p + sz > end:
            break
        out.append((ty, p, p + 8, p + sz))
        p += sz
    return out


def find(d, start, end, name):
    for ty, s, h, e in scan(d, start, end):
        if ty == name:
            return (ty, s, h, e)
    return None


def build_quicktime_meta():
    """A `meta` with children but no 4-byte version/flags prefix."""
    hdlr = box('hdlr', b'\x00' * 8 + b'mdta' + b'\x00' * 12 + b'\x00')

    def data_atom(text):
        return box('data', struct.pack('>II', 1, 0) + text.encode('utf-8'))

    ilst = box('ilst', box('\xa9too', data_atom('QtStyle Encoder 1.0')))
    return box('meta', hdlr + ilst)          # <-- no version/flags


def main(src, dst):
    d = bytearray(open(src, 'rb').read())

    top = scan(d, 0, len(d))
    moov = [b for b in top if b[0] == 'moov'][0]
    mdat = [b for b in top if b[0] == 'mdat'][0]
    assert moov[1] < mdat[1], 'expected a faststart source (moov before mdat)'

    moov_bytes = bytearray(d[moov[1]:moov[3]])

    # Rebuild moov, swapping udta/meta for the QuickTime-shaped one.
    old_udta = find(moov_bytes, 8, len(moov_bytes), 'udta')
    new_udta = box('udta', build_quicktime_meta())

    if old_udta:
        _ty, s, _h, e = old_udta
        moov_bytes[s:e] = new_udta
    else:
        moov_bytes += new_udta

    delta = len(moov_bytes) - (moov[3] - moov[1])

    # moov's own size header lives inside moov_bytes and must be updated too.
    struct.pack_into('>I', moov_bytes, 0, len(moov_bytes))

    # moov precedes mdat, so every chunk offset moves by the size change.
    if delta:
        for trak in [b for b in scan(moov_bytes, 8, len(moov_bytes)) if b[0] == 'trak']:
            stbl = None
            mdia = find(moov_bytes, trak[2], trak[3], 'mdia')
            if mdia:
                minf = find(moov_bytes, mdia[2], mdia[3], 'minf')
                if minf:
                    stbl = find(moov_bytes, minf[2], minf[3], 'stbl')
            if not stbl:
                continue
            for name, width in (('stco', 4), ('co64', 8)):
                offs = find(moov_bytes, stbl[2], stbl[3], name)
                if not offs:
                    continue
                _t, os_, oh, oe = offs
                n = struct.unpack('>I', moov_bytes[oh + 4:oh + 8])[0]
                for i in range(n):
                    at = oh + 8 + i * width
                    v = struct.unpack('>I' if width == 4 else '>Q',
                                      moov_bytes[at:at + width])[0]
                    moov_bytes[at:at + width] = struct.pack(
                        '>I' if width == 4 else '>Q', v + delta)

    out = bytearray()
    for ty, s, h, e in top:
        if ty == 'moov':
            out += moov_bytes
        else:
            out += d[s:e]

    open(dst, 'wb').write(out)
    print(f'{dst}: moov {moov[3]-moov[1]} -> {len(moov_bytes)} B, stco shifted {delta:+d} B')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
