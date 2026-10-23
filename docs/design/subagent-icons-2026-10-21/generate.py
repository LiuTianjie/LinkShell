#!/usr/bin/env python3
"""Original vector glyphs. Python standard library; rsvg-convert for preview only."""
from pathlib import Path
import json
import math
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
PALETTES = {
    "amber": (("#FFD59B", "#EE914C", "#FFF3D6"), ("#FFE1A2", "#FAAF66", "#FFF4D6")),
    "blue": (("#9FCFFF", "#548CE4", "#E5F3FF"), ("#B4DCFF", "#70A9FA", "#EDF7FF")),
    "mint": (("#A0E8CF", "#42B997", "#E7FFF5"), ("#B5F4DF", "#62CFAF", "#EEFFF9")),
    "teal": (("#8DDFDC", "#33AAA9", "#E1FFFF"), ("#AAF1E9", "#54C6BE", "#EDFFFF")),
    "iris": (("#C6B8FF", "#8F78D8", "#F4EFFF"), ("#DBCCFF", "#AF95F3", "#F7F1FF")),
    "rose": (("#F5B7CB", "#D8789E", "#FFF0F5"), ("#FFD1DF", "#F09CB9", "#FFF1F7")),
    "cyan": (("#9DDBF0", "#47A7CA", "#E9FAFF"), ("#BAEDFA", "#6EC8E4", "#F0FCFF")),
}

def number(value):
    return f"{value:.3f}".rstrip("0").rstrip(".")

def point(radius, degrees, cx=16, cy=16):
    theta = math.radians(degrees)
    return f"{number(cx + radius * math.cos(theta))},{number(cy + radius * math.sin(theta))}"

def polygon(points, fill="url(#main)", opacity=1, stroke="url(#edge)"):
    return f'<polygon points="{points}" fill="{fill}" opacity="{opacity}" stroke="{stroke}" stroke-width=".65" stroke-linejoin="round"/>'

def path(d, fill="url(#main)", opacity=1, stroke="url(#edge)", width=.65, **attrs):
    tail = " ".join(f'{key.replace("_", "-")}="{value}"' for key, value in attrs.items())
    return f'<path d="{d}" fill="{fill}" opacity="{opacity}" stroke="{stroke}" stroke-width="{width}" stroke-linejoin="round" stroke-linecap="round" {tail}/>'

def ellipse(cx, cy, rx, ry, rotation=0, fill="url(#main)", opacity=1, width=.65, stroke="url(#edge)"):
    return f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" transform="rotate({rotation} {cx} {cy})" fill="{fill}" opacity="{opacity}" stroke="{stroke}" stroke-width="{width}"/>'

def rotated(shape, degrees):
    return f'<g transform="rotate({degrees} 16 16)">{shape}</g>'

def solar():
    body = ""
    for i in range(8):
        a = i * 45 - 90
        body += polygon(" ".join([point(13.3, a), point(5.5, a+22.5), point(3.5, a), point(5.5, a-22.5)]), opacity=.78 if i % 2 else .98)
    return body + polygon(" ".join(point(4.3, a) for a in range(0, 360, 45)), "url(#reverse)")

def corolla():
    petal = path("M16 17 C9.7 13.6 9.7 5 16 3.1 C22.3 5 22.3 13.6 16 17Z", opacity=.82)
    return "".join(rotated(petal, a) for a in range(0, 360, 60)) + ellipse(16,16,2.5,2.5,fill="url(#reverse)")

def spring():
    return (ellipse(16,16,12.7,12.7,fill="url(#main)",opacity=.88)
        + ellipse(16,18,10,9.8,fill="url(#reverse)",opacity=.82)
        + ellipse(16,20.2,7.4,7.3,fill="url(#main)",opacity=.85)
        + path("M10.5 24.8 A6.1 6.1 0 1 1 21.5 24.8",fill="none",width=.75,opacity=.88))

def vane():
    wing = path("M16 16 C10.4 16 3.7 13.2 3.3 7.1 C8.6 4.2 14.6 6.2 16 16Z",opacity=.88)
    return "".join(rotated(wing, a) for a in [0,90,180,270]) + ellipse(16,16,2,2,fill="url(#reverse)")

def prism():
    body = polygon("16,2.8 27.4,9.4 27.4,22.6 16,29.2 4.6,22.6 4.6,9.4")
    body += polygon("16,2.8 16,16 4.6,9.4", "url(#reverse)", .78)
    body += polygon("16,16 27.4,9.4 27.4,22.6", "url(#reverse)", .60)
    body += polygon("4.6,22.6 16,16 16,29.2", "url(#reverse)", .62)
    body += path("M4.6 9.4 L16 16 L27.4 9.4 M16 16 V29.2",fill="none",width=.75)
    return body

def orbit():
    return (ellipse(16,16,6.5,6.5,fill="url(#reverse)",opacity=.9)
        + ellipse(16,16,13,5.6,-35,fill="none",width=1.6,stroke="url(#main)")
        + ellipse(16,16,13,5.6,35,fill="none",width=1.6,stroke="url(#main)")
        + ellipse(25.8,10,2.4,2.4,fill="url(#main)")
        + ellipse(6.2,10,1.55,1.55,fill="url(#reverse)"))

def mosaic():
    body = ""
    for x,y in [(16,8.2),(8.2,16),(23.8,16),(16,23.8)]:
        body += polygon(f"{x},{y-6.8} {x+6.8},{y} {x},{y+6.8} {x-6.8},{y}",opacity=.93)
        body += polygon(f"{x},{y-6.8} {x},{y} {x-6.8},{y}","url(#reverse)",.77)
    return body

def tide():
    return "".join(path(f"M3 {y+3} C8 {y-4} 12 {y-4} 16 {y} C20 {y+4} 24 {y+4} 29 {y-3} L29 {y+2} C24 {y+9} 20 {y+9} 16 {y+5} C12 {y+1} 8 {y+1} 3 {y+8}Z",opacity=op) for y,op in [(6,.65),(12,.8),(18,.98)])

def lantern():
    return (ellipse(16,16,12.3,12.6)
        + ellipse(16,16,8.2,12.6,fill="url(#reverse)",opacity=.82)
        + ellipse(16,16,3.6,12.6,fill="url(#main)",opacity=.78)
        + path("M4.8 11.6 Q16 6.8 27.2 11.6 M4.8 20.4 Q16 25.2 27.2 20.4",fill="none",width=.65,opacity=.85))

def bow():
    petal = path("M16 16 C14.5 11.3 3.5 4 3.5 12 C3.5 19.5 11.2 20.5 16 16Z",opacity=.88)
    return "".join(rotated(petal,a) for a in [0,90,180,270]) + polygon("16,12.4 19.6,16 16,19.6 12.4,16","url(#reverse)")

def link():
    first = path("M4 10.5 C4 5 9.5 3 13.5 6 L21.5 12 C26 15.2 26 21 22 24 C18 27 13 25.6 10 21.6 L6 16.5 C4.6 14.7 4 12.8 4 10.5Z M8 11 C8 12.2 8.4 13 9.4 14.4 L13.6 19.7 C15.5 22.2 18 23 20 21.4 C22 19.8 21.5 17 19 15.3 L11.5 9.9 C9.6 8.5 8 9 8 11Z",opacity=.89,fill_rule="evenodd")
    return first + rotated(first,180)

def trefoil():
    blade = path("M15.6 17 C10 19.7 3 18 2.5 12.5 C2 7.5 7.8 4.5 12.1 7.3 C15.3 9.4 16.4 13 15.6 17Z",opacity=.9)
    return "".join(rotated(blade,a) for a in [0,120,240]) + ellipse(16,16,3,3,fill="url(#reverse)")

def eclipse():
    return (ellipse(12.2,16,9.4,11.8,fill="url(#main)",opacity=.82)
        + ellipse(20,16,9.1,11.8,fill="url(#reverse)",opacity=.82)
        + path("M16 5.2 C9.4 10.9 9.4 21.1 16 26.8 C22.6 21.1 22.6 10.9 16 5.2Z",opacity=.83)
        + path("M16 5.2 C12.2 11.6 12.2 20.4 16 26.8",fill="none",opacity=.75))

def summit():
    return (polygon("16,3 29,13 16,19 3,13",opacity=.63)
        + polygon("16,9 29,19 16,25 3,19",opacity=.84)
        + polygon("16,15 29,25 16,30 3,25",opacity=.98)
        + path("M16 3 V19 M16 9 V25 M16 15 V30",fill="none",opacity=.76))

def pebble():
    body = ""
    petal = path("M13 3.5 Q16 1 19 3.5 L22.5 7 Q24 10.5 20.5 12.5 L16 15.5 L11.5 12.5 Q8 10.5 9.5 7Z",opacity=.78)
    for a in [0,72,144,216,288]:
        body += rotated(petal,a)
    return body + polygon(" ".join(point(3.2,a) for a in range(-90,270,72)),"url(#reverse)")

def aperture():
    body = ""
    for i,a in enumerate([0,90,180,270]):
        blade = path("M6 4 H18 L18 9 H11 V19 H6Z",opacity=.72+i*.065)
        body += rotated(blade,a)
    return body + polygon("12.5,12.5 19.5,12.5 19.5,19.5 12.5,19.5","url(#reverse)",.7)

GLYPHS = [
    ("solar", "Solar", "amber", solar),
    ("corolla", "Corolla", "blue", corolla),
    ("spring", "Spring", "mint", spring),
    ("vane", "Vane", "teal", vane),
    ("prism", "Prism", "cyan", prism),
    ("orbit", "Orbit", "amber", orbit),
    ("mosaic", "Mosaic", "iris", mosaic),
    ("tide", "Tide", "blue", tide),
    ("lantern", "Lantern", "amber", lantern),
    ("bow", "Bow", "rose", bow),
    ("link", "Link", "mint", link),
    ("trefoil", "Trefoil", "iris", trefoil),
    ("eclipse", "Eclipse", "rose", eclipse),
    ("summit", "Summit", "teal", summit),
    ("pebble", "Pebble", "iris", pebble),
    ("aperture", "Aperture", "cyan", aperture),
]

def inner_svg(color, theme, drawing):
    light, deep, shine = PALETTES[color][theme == "dark"]
    edge = "#FFFFFF" if theme == "light" else shine
    geometry = drawing()
    if theme == "dark":
        # Raise coverage instead of placing pastel translucent shapes directly
        # on near-black, which turns the small silhouettes grey and muddy.
        geometry = re.sub(r'(?<!-)opacity="([\d.]+)"', lambda m: f'opacity="{number(.8+.2*float(m[1]))}"', geometry)
    return f'''<defs>
      <linearGradient id="main" x1="6" y1="3" x2="26" y2="29" gradientUnits="userSpaceOnUse"><stop stop-color="{light}"/><stop offset="1" stop-color="{deep}"/></linearGradient>
      <linearGradient id="reverse" x1="24" y1="28" x2="7" y2="4" gradientUnits="userSpaceOnUse"><stop stop-color="{light}"/><stop offset="1" stop-color="{shine}"/></linearGradient>
      <linearGradient id="edge" x1="8" y1="3" x2="24" y2="29" gradientUnits="userSpaceOnUse"><stop stop-color="{edge}" stop-opacity=".96"/><stop offset="1" stop-color="{shine}" stop-opacity=".58"/></linearGradient>
    </defs>{geometry}'''

def svg_document(color, theme, drawing):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">{inner_svg(color,theme,drawing)}</svg>\n'

def text(x,y,content,size=12,color="#85858F",weight=400):
    return f'<text x="{x}" y="{y}" fill="{color}" font-family="Helvetica Neue, Arial, sans-serif" font-size="{size}" font-weight="{weight}">{content}</text>'

def contact_sheet():
    width,height = 1200,1152
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">', '<rect width="1200" height="1152" fill="#F4F4F5"/>']
    out += [text(40,48,"LinkShell / Agent glyphs",26,"#24242B",600),text(40,74,"16 ORIGINAL VECTORS  ·  LIGHT + DARK  ·  20 / 24 PX SAMPLES",11,"#777780",500)]
    for i,(slug,label,color,drawing) in enumerate(GLYPHS):
        x,y = 40+(i%4)*284,106+(i//4)*246
        out += [f'<rect x="{x}" y="{y}" width="268" height="230" rx="16" fill="#FFFFFF"/>', text(x+16,y+25,f"{i+1:02d}  {label}",12,"#44444E",500)]
        for ti,theme in enumerate(["light","dark"]):
            px = x+12+ti*124
            bg = "#F9F9FA" if ti == 0 else "#222329"
            fg = "#9999A3" if ti == 0 else "#9899A3"
            out += [f'<rect x="{px}" y="{y+38}" width="120" height="176" rx="10" fill="{bg}"/>',text(px+12,y+56,theme.upper(),8,fg,500)]
            for size,sx,sy in [(72,px+24,y+70),(20,px+25,y+173),(24,px+73,y+171)]:
                content=inner_svg(color,theme,drawing)
                unique=f"{slug}-{theme}-{size}"
                for old in ["main","reverse","edge"]:
                    content=content.replace(f'id="{old}"',f'id="{old}-{unique}"').replace(f'url(#{old})',f'url(#{old}-{unique})')
                out += [f'<svg x="{sx}" y="{sy}" width="{size}" height="{size}" viewBox="0 0 32 32">{content}</svg>']
            out += [text(px+25,y+162,"20",8,fg),text(px+76,y+162,"24",8,fg)]
    out += [text(40,1120,"32 × 32 source  /  gradients + translucent layers  /  independent silhouettes  /  no filters",11,"#85858F"), '</svg>']
    return "".join(out)

def main():
    manifest = {"version":1,"viewBox":[0,0,32,32],"recommendedSizes":[20,24,32],"glyphs":[]}
    for i,(slug,label,color,drawing) in enumerate(GLYPHS):
        entry = {"id":slug,"label":label,"index":i,"palette":color,"files":{}}
        for theme in ["light","dark"]:
            folder=ROOT/theme
            folder.mkdir(exist_ok=True)
            file=f"{theme}/{i+1:02d}-{slug}.svg"
            (ROOT/file).write_text(svg_document(color,theme,drawing))
            entry["files"][theme]=file
        manifest["glyphs"].append(entry)
    (ROOT/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    (ROOT/"contact-sheet.svg").write_text(contact_sheet())
    subprocess.run(["/opt/homebrew/bin/rsvg-convert",str(ROOT/"contact-sheet.svg"),"-o",str(ROOT/"contact-sheet.png")],check=True)
    with zipfile.ZipFile(ROOT/"linkshell-agent-glyphs.zip","w",zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(ROOT.rglob("*")):
            if file.is_file() and file.suffix != ".zip" and "__pycache__" not in file.parts:
                archive.write(file,file.relative_to(ROOT))
    print(f"Created {len(GLYPHS)*2} SVG glyphs and light/dark preview: {ROOT}")

if __name__ == "__main__":
    main()
