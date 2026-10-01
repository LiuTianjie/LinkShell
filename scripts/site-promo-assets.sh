#!/bin/bash
# Makes what the website and the READMEs show from the promo film
# (promo/out, not in the repository): the film for the web, a clip and a
# still per feature, and the feature cards.
# Usage: ./scripts/site-promo-assets.sh   (needs ffmpeg)
set -e
cd "$(dirname "$0")/.."
L=promo/out/linkshell-2.0-zh.mp4
V=promo/out/linkshell-2.0-zh-vertical.mp4
O=docs/site/assets/promo
[ -f "$L" ] && [ -f "$V" ] || { echo "promo/out has no film to cut from"; exit 1; }
mkdir -p "$O"

ffmpeg -y -loglevel error -i "$L" -an -vf scale=1600:900:flags=lanczos -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart "$O/linkshell-2.0.mp4"
ffmpeg -y -loglevel error -i "$V" -an -vf scale=720:1280:flags=lanczos -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart "$O/linkshell-2.0-vertical.mp4"
ffmpeg -y -loglevel error -ss "${POSTER_AT:-4.2}" -i "$L" -frames:v 1 -vf scale=1600:900:flags=lanczos -q:v 3 "$O/poster.jpg"
ffmpeg -y -loglevel error -ss "${POSTER_AT:-4.2}" -i "$V" -frames:v 1 -vf scale=720:1280:flags=lanczos -q:v 3 "$O/poster-vertical.jpg"

# name, clip start, clip end, the moment its still is taken (seconds into the film)
SCENES="${SCENES:-follow:5.9:12.1:11.8 handoff:12.9:21.9:21.4 queue:22.7:29.3:28.9 agents:30.1:35.8:35.4 fork:36.6:42.3:41.9 slash:43.1:46.8:46.4 e2e:47.6:52.8:52.4}"
for scene in $SCENES; do
  IFS=: read -r name from to still <<< "$scene"
  ffmpeg -y -loglevel error -ss "$from" -to "$to" -i "$L" -an -vf scale=1120:630:flags=lanczos -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart "$O/$name.mp4"
  ffmpeg -y -loglevel error -ss "$still" -i "$L" -frames:v 1 -vf scale=1120:630:flags=lanczos -q:v 4 "$O/$name.jpg"
  ffmpeg -y -loglevel error -ss "$still" -i "$V" -frames:v 1 -vf scale=540:960:flags=lanczos -q:v 4 "$O/card-$name.jpg"
done
du -sh "$O"
