#!/bin/bash
# Makes what the website and the READMEs show from the promo film (promo/film2/out, not in the
# repository): the film in both languages and both shapes with their stills, the three feature
# clips (the phone's screen alone: the page draws the phone around them) and the READMEs' cards.
# Usage: ./scripts/site-promo-assets.sh   (needs ffmpeg; build the film first: promo/film2/README.md, git-ignored)
set -e
cd "$(dirname "$0")/.."
S=promo/film2/out
O=docs/site/assets/promo
for f in wide-zh tall-zh wide-en tall-en; do [ -f "$S/linkshell-$f.mp4" ] || { echo "promo/film2/out has no linkshell-$f.mp4"; exit 1; }; done
mkdir -p "$O"

film() { ffmpeg -y -loglevel error -i "$1" -an -vf "scale=${2}:flags=lanczos" -c:v libx264 -preset slow -crf "$4" -pix_fmt yuv420p -movflags +faststart "$3"; }
still() { ffmpeg -y -loglevel error -ss "$4" -i "$1" -frames:v 1 -vf "scale=${2}:flags=lanczos" -q:v "${5:-3}" "$3"; }

# The Chinese film keeps the file names that links already out there point at.
film "$S/linkshell-wide-zh.mp4" 1600:900 "$O/linkshell-2.0.mp4" 26
film "$S/linkshell-tall-zh.mp4" 720:1280 "$O/linkshell-2.0-vertical.mp4" 27
film "$S/linkshell-wide-en.mp4" 1600:900 "$O/linkshell-en.mp4" 26
film "$S/linkshell-tall-en.mp4" 720:1280 "$O/linkshell-en-vertical.mp4" 27
# The page's stills: the permission request. The READMEs' posters: the opening, with the tagline.
still "$S/linkshell-wide-zh.mp4" 1600:900 "$O/film.jpg" 13.2
still "$S/linkshell-tall-zh.mp4" 720:1280 "$O/film-vertical.jpg" 13.2
still "$S/linkshell-wide-en.mp4" 1600:900 "$O/film-en.jpg" 13.2
still "$S/linkshell-tall-en.mp4" 720:1280 "$O/film-en-vertical.jpg" 13.2
still "$S/linkshell-wide-zh.mp4" 1600:900 "$O/poster.jpg" 1.8
still "$S/linkshell-wide-en.mp4" 1600:900 "$O/poster-en.jpg" 1.8
# The feature clips and the READMEs' cards come from the recordings themselves.
for name in follow queue screen; do cp "$S/clip-$name.mp4" "$S/clip-$name.jpg" "$O/"; cp "$S/card-$name.jpg" "$O/"; done
du -sh "$O"
