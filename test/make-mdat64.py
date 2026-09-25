"""
Rewrite an MP4's `mdat` to use a 64-bit size header (size==1 + largesize),
which is what phones emit so the box can grow past 4 GB. The header doubles
from 8 to 16 bytes, so the payload moves and every chunk offset shifts by 8.

  py test/make-mdat64.py test/source.mp4 test/mdat64.mp4
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
        header = 8
        if sz == 1:
            sz = struct.unpack('>Q', d[p + 8:p + 16])[0]
            header = 16
        elif sz == 0:
            sz = end - p
        if sz < header or p + sz > end:
            break
        out.append((ty, p, p + header, p + sz))
        p += sz
    return out


def find(d, start, end, name):
    for b in scan(d, start, end):
        if b[0] == name:
            return b
    return None


def main(src, dst):
    d = bytearray(open(src, 'rb').read())

    top = scan(d, 0, len(d))
    moov = find(d, 0, len(d), 'moov')
    mdat = find(d, 0, len(d), 'mdat')
    assert moov and mdat, 'need both moov and mdat'
    assert moov[1] < mdat[1], 'expected moov before mdat'
    assert mdat[2] - mdat[1] == 8, 'source mdat already uses a 64-bit header'

    # Payload keeps its bytes; the header grows 8 -> 16, so everything after
    # the header moves by +8.
    delta = 8
    payload = d[mdat[2]:mdat[3]]
    new_mdat = struct.pack('>I', 1) + b'mdat' + struct.pack('>Q', len(payload) + 16) + payload
    assert len(new_mdat) == (mdat[3] - mdat[1]) + delta

    moov_bytes = bytearray(d[moov[1]:moov[3]])
    for trak in [b for b in scan(moov_bytes, 8, len(moov_bytes)) if b[0] == 'trak']:
        mdia = find(moov_bytes, trak[2], trak[3], 'mdia')
        if not mdia:
            continue
        minf = find(moov_bytes, mdia[2], mdia[3], 'minf')
        if not minf:
            continue
        stbl = find(moov_bytes, minf[2], minf[3], 'stbl')
        if not stbl:
            continue
        for name, width in (('stco', 4), ('co64', 8)):
            offs = find(moov_bytes, stbl[2], stbl[3], name)
            if not offs:
                continue
            oh = offs[2]
            n = struct.unpack('>I', moov_bytes[oh + 4:oh + 8])[0]
            for i in range(n):
                at = oh + 8 + i * width
                fmt = '>I' if width == 4 else '>Q'
                v = struct.unpack(fmt, moov_bytes[at:at + width])[0]
                moov_bytes[at:at + width] = struct.pack(fmt, v + delta)

    out = bytearray()
    for ty, s, h, e in top:
        if ty == 'mdat':
            out += new_mdat
        elif ty == 'moov':
            out += moov_bytes
        else:
            out += d[s:e]

    open(dst, 'wb').write(out)
    print(f'{dst}: mdat header 8 -> 16 B, payload/offsets shifted {delta:+d} B')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
