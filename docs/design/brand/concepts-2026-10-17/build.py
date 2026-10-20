from pathlib import Path
from xml.etree import ElementTree as ET
p=Path(__file__).parent
# Filled outlines keep template artwork independent of stroke rendering.
ring='M78 40H178Q216 40 216 78V178Q216 216 178 216H78Q40 216 40 178V78Q40 40 78 40ZM78 55Q55 55 55 78V178Q55 201 78 201H178Q201 201 201 178V78Q201 55 178 55Z'
chev='M83 89Q87 85 91 89L122 120Q128 126 122 132L91 163Q87 167 83 163Q79 159 83 155L111 126 83 98Q79 94 83 89Z'
cloud='M73 80C80 52 101 37 128 37C156 37 179 55 185 82C208 85 223 104 223 128V164C223 194 203 214 174 214H81C51 214 32 194 32 165V128C32 101 49 83 73 80ZM84 94C63 94 47 107 47 129V165C47 186 60 199 81 199H174C195 199 208 185 208 164V128C208 108 195 96 173 96C172 69 153 52 128 52C105 52 88 68 84 94Z'
concepts=[
 ('01','流光终端','保留熟悉的终端轮廓，让比例与光线更克制。',
 f'<path d="{ring}" fill="url(#edge)" fill-rule="evenodd"/><path d="{chev}" fill="url(#ink)"/><rect x="137" y="151" width="34" height="12" rx="6" fill="url(#ink)"/>',
 f'<path d="{ring}" fill-rule="evenodd"/><path d="{chev}"/><rect x="137" y="151" width="34" height="12" rx="6"/>',
 '<rect x="49" y="49" width="158" height="158" rx="29" fill="url(#face)"/>'),
 ('02','双窗相连','两端相连的窗口，前后层次表达远程操作。',
 '<path d="M112 37H180Q216 37 216 73V143H201V73Q201 52 180 52H112Q91 52 91 73V87H76V73Q76 37 112 37Z" fill="url(#edge)"/><path d="M71 73H148Q184 73 184 109V183Q184 219 148 219H71Q35 219 35 183V109Q35 73 71 73ZM71 88Q50 88 50 109V183Q50 204 71 204H148Q169 204 169 183V109Q169 88 148 88Z" fill="url(#edge)" fill-rule="evenodd"/><path d="m77 117 25 25q4 4 0 8l-25 25q-4 4-8 0t0-8l21-21-21-21q-4-4 0-8t8 0Z" fill="url(#ink)"/><rect x="116" y="165" width="28" height="11" rx="5.5" fill="url(#ink)"/>',
 '<path d="M112 37H180Q216 37 216 73V143H199V73Q199 54 180 54H112Q93 54 93 73H76Q76 37 112 37Z"/><path d="M71 73H148Q184 73 184 109V183Q184 219 148 219H71Q35 219 35 183V109Q35 73 71 73ZM71 90Q52 90 52 109V183Q52 202 71 202H148Q167 202 167 183V109Q167 90 148 90Z" fill-rule="evenodd"/><path d="m76 116 29 29-29 29-10-10 19-19-19-19Z"/>',
 '<rect x="43" y="81" width="133" height="130" rx="28" fill="url(#face)"/>'),
 ('03','一体外壳','把云与终端合成一个轮廓，不再叠加小徽标。',
 f'<path d="{cloud}" fill="url(#edge)" fill-rule="evenodd"/><path d="m86 109 27 27q5 5 0 10l-27 27q-4 4-8 0t0-8l23-24-23-24q-4-4 0-8t8 0Z" fill="url(#ink)"/><rect x="132" y="163" width="36" height="12" rx="6" fill="url(#ink)"/>',
 f'<path d="{cloud}" fill-rule="evenodd"/><path d="m84 106 34 34-34 34-11-11 23-23-23-23Z"/><rect x="136" y="159" width="32" height="14" rx="7"/>',
 '<path d="M80 87C86 61 103 45 128 45S174 64 179 89C201 92 216 106 216 128V164Q216 207 174 207H81Q39 207 39 165V128Q39 92 80 87Z" fill="url(#face)"/>')]
def svg(n,mode='app'):
 _,_,_,mark,mono,face=concepts[n]
 defs='''<defs><linearGradient id="back" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#2a303b"/><stop offset="1" stop-color="#10151f"/></linearGradient><linearGradient id="edge" x1=".1" y1="1" x2=".85" y2="0"><stop stop-color="#9ef2d9"/><stop offset=".52" stop-color="#6bcdf4"/><stop offset="1" stop-color="#a69af6"/></linearGradient><linearGradient id="ink" x2="0" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#e1e5ff"/></linearGradient><linearGradient id="face" x2=".8" y2="1"><stop stop-color="#26394b"/><stop offset="1" stop-color="#1b2230"/></linearGradient><filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter></defs>'''
 if mode=='app':
  body='<g id="background"><rect width="256" height="256" fill="url(#back)"/></g><g id="ambient" opacity=".13" filter="url(#soft)">'+mark+'</g><g id="surface">'+face+'</g><g id="brand">'+mark+'</g>'
 elif mode in ('template','favicon'):
  if mode=='favicon':
   import re
   mono=re.sub(r'<rect[^>]*/>', '', mono)
  body='<g fill="#000">'+mono+'</g>'
 elif mode=='light':body='<g fill="#344d75">'+mono+'</g>'
 else:body=mark
 if mode in ('template','favicon','light'): defs=''
 view='24 24 208 208' if mode in ('template','favicon') else '0 0 256 256'
 return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="{view}">'+defs+body+'</svg>'
for i,c in enumerate(concepts):
 d=p/c[0];d.mkdir(exist_ok=True)
 for file,mode in [('app-ios','app'),('brand-light','light'),('brand-dark','dark'),('menubar-template','template'),('favicon','favicon')]:
  data=svg(i,mode);ET.fromstring(data);(d/f'{file}.svg').write_text(data)
# Self-contained comparison page; masks are preview only, never baked into app-ios.svg.
rows=[]
for i,(num,title,desc,*_) in enumerate(concepts):
 rows.append(f'''<section><div class="identity"><span class="number">{num}</span><h2>{title}</h2><p>{desc}</p><a href="{num}/app-ios.svg">查看主图 SVG ↗</a></div><div class="app"><img src="{num}/app-ios.svg"><small>APP · 系统圆角预览</small></div><div class="brands"><div class="light"><img src="{num}/brand-light.svg"></div><div class="dark"><img src="{num}/brand-dark.svg"></div><small>透明品牌标 · 亮 / 暗底</small></div><div class="detail"><div class="bar light"><img src="{num}/menubar-template.svg"><span>⌁ &nbsp; ◉ &nbsp; 100%</span></div><div class="bar dark"><img src="{num}/menubar-template.svg"><span>⌁ &nbsp; ◉ &nbsp; 100%</span></div><small>菜单栏 · 18 pt 实际尺寸</small><div class="fav"><img width="16" height="16" src="{num}/favicon.svg"><img width="32" height="32" src="{num}/favicon.svg"><small>16 / 32 px</small></div></div></section>''')
(p/'index.html').write_text('''<!doctype html><html lang="zh"><meta charset="utf-8"><title>LinkShell 品牌候选</title><style>*{box-sizing:border-box}body{margin:0;background:#f1f2f5;color:#272c38;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:48px}header{margin-bottom:32px}header b{font-size:11px;letter-spacing:3px;color:#737b8e}h1{font-size:28px;font-weight:600;letter-spacing:-.8px;margin:12px 0}header p{color:#737b8e;font-size:13px}section{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr;gap:32px;align-items:center;padding:30px;margin:18px 0;background:#fff;border-radius:20px;border:1px solid #e4e7ee}.number{color:#8a93a7;font-size:12px}h2{font-size:20px;font-weight:550}.identity p{font-size:13px;line-height:1.7;max-width:220px;color:#727b8a}a{font-size:12px;color:#556794;text-decoration:none}.app>img{width:160px;height:160px;border-radius:35px;display:block;box-shadow:0 8px 18px #16243a18}.app small{margin-top:15px}.brands{display:grid;grid-template-columns:1fr 1fr;gap:8px}.brands>div{border-radius:12px;display:grid;place-items:center;height:88px}.brands img{width:72px;height:72px}.brands small{grid-column:span 2}.light{background:#f1f3f7}.dark{background:#1c2230}.bar{height:34px;display:flex;align-items:center;gap:22px;padding:0 14px;border-radius:7px;margin-bottom:8px}.bar img{width:18px;height:18px}.bar span{font-size:11px;color:#808999}.bar.dark img{filter:invert(1)}small{display:block;font-size:10px;color:#9299a8;letter-spacing:.4px}.fav{display:flex;align-items:center;gap:18px;height:55px;margin-top:12px}.fav small{display:inline}@media(max-width:900px){body{padding:22px}section{grid-template-columns:1fr 1fr}.app>img{width:150px;height:150px}}</style><header><b>LINKSHELL / BRAND EXPLORATION</b><h1>同一枚标识，从主屏幕到菜单栏。</h1><p>保留蓝青渐变与圆润质感 · 先确定主形，再完成平台交付</p></header>'''+''.join(rows)+'</html>')
(p/'README.md').write_text('''# LinkShell 品牌候选

这三套为主标选择稿，不是完整平台交付包。预览见 index.html。

- 01 流光终端：接近原图；移除云朵，保留终端。
- 02 双窗相连：重叠窗口表达两个设备端；小尺寸去掉光标。
- 03 一体外壳：把云朵与终端合成一个轮廓。

每套提供 app-ios.svg、brand-light.svg、brand-dark.svg、menubar-template.svg、favicon.svg。
主图满画布且无预画圆角；页面中的圆角仅用于系统裁切预览。SVG 分离背景、氛围光、内表面和主形；菜单栏使用纯黑实心路径与透明背景。彩色与单色均可直接编辑。

18 pt / 16 px 为浏览器实际尺寸预览；尚未完成 macOS template 系统着色、真机主屏幕或 Android 遮罩验收。主标确定后再输出独立 Mac 构图、Android 前景/背景/单色、启动页、PWA/maskable、分享卡及各尺寸 PNG，并接入资源。
''')
print(p.resolve()/'index.html')
