#!/bin/bash
# Makes what the website and the READMEs show from the promo film
# (promo/out, not in the repository): the film for the web, and for each
# feature a clip and a still in both shapes (16:9 for wide screens, 9:16 for
# phones). The page shows the still and plays the clip over it, so a still and
# its clip must have the same size.
# Usage: ./scripts/site-promo-assets.sh   (needs ffmpeg)
set -e
cd "$(dirname "$0")/.."
L=promo/out/linkshell-2.0-zh.mp4
V=promo/out/linkshell-2.0-zh-vertical.mp4
O=docs/site/assets/promo
[ -f "$L" ] && [ -f "$V" ] || { echo "promo/out has no film to cut from"; exit 1; }
mkdir -p "$O"

WIDE=1600:900
TALL=720:1280
clip() { ffmpeg -y -loglevel error "${@:4}" -i "$1" -an -vf "scale=$2:flags=lanczos" -c:v libx264 -preset slow -crf "${CRF:-28}" -pix_fmt yuv420p -movflags +faststart "$3"; }
still() { ffmpeg -y -loglevel error -ss "$4" -i "$1" -frames:v 1 -vf "scale=$2:flags=lanczos" -q:v "${5:-4}" "$3"; }

CRF=27 clip "$L" $WIDE "$O/linkshell-2.0.mp4"
clip "$V" $TALL "$O/linkshell-2.0-vertical.mp4"
# The READMEs' poster: the hook, with the tagline.
still "$L" $WIDE "$O/poster.jpg" "${POSTER_AT:-4.2}" 3
# The website's still for the film: the handoff, without the tagline (the page's own headline says it).
still "$L" $WIDE "$O/film.jpg" "${FILM_STILL_AT:-17}" 3
still "$V" $TALL "$O/film-vertical.jpg" "${FILM_STILL_AT:-17}" 3

# name, clip start, clip end, the moment its still is taken (seconds into the film).
# A still is taken while the phone is whole in the frame, not during a push-in.
SCENES="${SCENES:-follow:5.9:12.1:11.8 handoff:12.9:21.9:21.4 queue:22.7:29.3:24.4 agents:30.1:35.8:35.4 fork:36.6:42.3:41.9 slash:43.1:46.8:46.4 e2e:47.6:52.8:52.4}"
for scene in $SCENES; do
  IFS=: read -r name from to at <<< "$scene"
  clip "$L" $WIDE "$O/$name.mp4" -ss "$from" -to "$to"
  clip "$V" $TALL "$O/$name-vertical.mp4" -ss "$from" -to "$to"
  still "$L" $WIDE "$O/$name.jpg" "$at"
  # card-*.jpg: the 9:16 stills, also what the READMEs show.
  still "$V" $TALL "$O/card-$name.jpg" "$at"
done
du -sh "$O"
