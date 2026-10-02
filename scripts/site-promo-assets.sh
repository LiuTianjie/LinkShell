#!/bin/bash
# Makes what the website and the READMEs show from the promo film
# (promo/film/out, not in the repository): the film in both shapes with its
# stills, the three feature clips (the phone's screen alone: the page draws
# the phone around them) and the READMEs' cards.
# Usage: ./scripts/site-promo-assets.sh   (needs ffmpeg; build the film first: see promo/film/README.md)
set -e
cd "$(dirname "$0")/.."
S=promo/film/out
O=docs/site/assets/promo
[ -f "$S/linkshell-wide.mp4" ] && [ -f "$S/linkshell-tall.mp4" ] || { echo "promo/film/out has no film to cut from"; exit 1; }
rm -rf "$O" && mkdir -p "$O"

film() { ffmpeg -y -loglevel error -i "$1" -an -vf "scale=$2:flags=lanczos" -c:v libx264 -preset slow -crf "$4" -pix_fmt yuv420p -movflags +faststart "$3"; }
still() { ffmpeg -y -loglevel error -ss "$4" -i "$1" -frames:v 1 -vf "scale=$2:flags=lanczos" -q:v "${5:-4}" "$3"; }

# (The file names say 2.0: links to the film that are already out there keep working.)
film "$S/linkshell-wide.mp4" 1600:900 "$O/linkshell-2.0.mp4" 26
film "$S/linkshell-tall.mp4" 720:1280 "$O/linkshell-2.0-vertical.mp4" 27
# The page's still for the film: the approval. The READMEs' poster: the opening, with the tagline.
still "$S/linkshell-wide.mp4" 1600:900 "$O/film.jpg" 10.0 3
still "$S/linkshell-tall.mp4" 720:1280 "$O/film-vertical.jpg" 10.0 3
still "$S/linkshell-wide.mp4" 1600:900 "$O/poster.jpg" 1.6 3
# The READMEs' cards: 9:16 stills of three moments.
still "$S/linkshell-tall.mp4" 720:1280 "$O/card-follow.jpg" 10.0
still "$S/linkshell-tall.mp4" 720:1280 "$O/card-queue.jpg" 20.0
still "$S/linkshell-tall.mp4" 720:1280 "$O/card-screen.jpg" 33.0
for name in follow queue screen; do cp "$S/clip-$name.mp4" "$S/clip-$name.jpg" "$O/"; done
du -sh "$O"
