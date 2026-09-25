#!/bin/sh
# Resolution / frame-rate fixtures: 1080p and 4K at 30 and 60 fps.
set -e
cd "$(dirname "$0")"

for spec in 1080p30:1920x1080:30 1080p60:1920x1080:60 4k30:3840x2160:30 4k60:3840x2160:60; do
  name=${spec%%:*}
  rest=${spec#*:}
  size=${rest%%:*}
  fps=${rest#*:}

  # H.264
  ffmpeg -y -v error \
    -f lavfi -i "testsrc2=size=$size:rate=$fps:duration=2" \
    -f lavfi -i "sine=frequency=440:duration=2" \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 128k \
    -movflags +faststart "res_${name}_h264.mp4"
  echo "  res_${name}_h264.mp4"

  # HEVC
  ffmpeg -y -v error \
    -f lavfi -i "testsrc2=size=$size:rate=$fps:duration=2" \
    -f lavfi -i "sine=frequency=440:duration=2" \
    -c:v libx265 -preset ultrafast -tag:v hvc1 -pix_fmt yuv420p -c:a aac -b:a 128k \
    -movflags +faststart "res_${name}_hevc.mp4"
  echo "  res_${name}_hevc.mp4"
done

echo "resolution fixtures written to $(pwd)"
