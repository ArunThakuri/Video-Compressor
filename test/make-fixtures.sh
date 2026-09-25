#!/bin/sh
# Regenerate the test fixtures. Requires ffmpeg on PATH.
set -e
cd "$(dirname "$0")"
V="-f lavfi -i testsrc2=size=640x360:rate=30:duration=3"
A="-f lavfi -i sine=frequency=440:duration=3"

ffmpeg -y -v error $V $A -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart source.mp4
ffmpeg -y -v error $V $A -c:v libx264 -pix_fmt yuv420p -c:a aac noFaststart.mp4
ffmpeg -y -v error $V $A -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p -c:a aac hevc.mp4
ffmpeg -y -v error $V $A -c:v libx264 -pix_fmt yuv420p -c:a aac -f mov source.mov
ffmpeg -y -v error -f lavfi -i testsrc2=size=320x180:rate=30:duration=1 \
  -c:v libx264 -pix_fmt yuv420p -movflags frag_keyframe+empty_moov -f mp4 frag.mp4
ffmpeg -y -v error -f lavfi -i testsrc2=size=320x180:rate=30:duration=1 -c:v libvpx-vp9 -f mp4 vp9.mp4
# meta-flavour fixtures: ffmpeg writes an ISO (FullBox) meta; make-qt-meta.py
# rewrites it into the QuickTime shape that phones and Apple-adjacent editors use.
ffmpeg -y -v error $V $A -c:v libx264 -pix_fmt yuv420p -c:a aac   -metadata title=x -metadata artist=y -movflags +faststart meta_iso.mp4
py make-qt-meta.py meta_iso.mp4 meta_qt.mp4

# mdat with a 64-bit size header (size==1 + largesize), as phones write it.
py make-mdat64.py source.mp4 mdat64.mp4

# VP9 in MP4, with audio so it exercises the codec path rather than being
# rejected for a missing AAC track.
ffmpeg -y -v error -f lavfi -i testsrc2=size=320x180:rate=30:duration=1 \
  -f lavfi -i sine=frequency=440:duration=1 \
  -c:v libvpx-vp9 -cpu-used 8 -b:v 200k -pix_fmt yuv420p -c:a aac -f mp4 vp9.mp4

# Codec-tag variants. make-codec-fixture.py rewrites the sample-entry fourcc in
# place, which is exactly the difference between an HEVC file and a Dolby Vision
# one at the container level.
py make-codec-fixture.py hevc.mp4   dv_hevc.mp4 dvh1
py make-codec-fixture.py source.mp4 dv_avc.mp4  dvav

# AV1
ffmpeg -y -v error -f lavfi -i testsrc2=size=320x180:rate=30:duration=1 \
  -f lavfi -i sine=frequency=440:duration=1 \
  -c:v libaom-av1 -cpu-used 8 -crf 45 -pix_fmt yuv420p -c:a aac av1.mp4

echo "fixtures written to $(pwd)"
