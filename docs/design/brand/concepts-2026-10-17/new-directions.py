from pathlib import Path
from xml.etree import ElementTree as ET
p=Path(__file__).parent
# Independent paths define the mark; color is an optional treatment.
studies=[
('05','回声','ECHO SHELL','把壳的螺旋生长压缩成一道曲面。外缘饱满，内侧收尖，让形状兼有包裹感与流动感。',[
'M65 207C32 186 22 145 37 105C54 61 98 34 145 41C190 48 219 84 216 126C213 167 184 197 149 197C117 197 96 176 98 151C100 128 118 116 137 121C153 125 160 139 153 152C151 142 142 138 134 143C126 148 129 159 139 163C157 170 176 153 180 132C185 104 168 80 140 77C109 73 81 92 72 120C62 149 73 176 95 190Z'],['#516fda','#94c1ef','#a5c5f3'],'#e9edf5'),
('06','跃迁','SLIPSTREAM','两道错开的弧面，围绕一个透空的入口。开口打断闭环，让两端的方向保持可见。',[
'M47 167C63 115 104 65 183 47C194 45 203 52 205 62C211 89 202 114 179 133C164 145 145 153 125 157C149 141 168 120 176 92C118 105 78 132 47 167Z',
'M209 89C193 141 152 191 73 209C62 211 53 204 51 194C45 167 54 142 77 123C92 111 111 103 131 99C107 115 88 136 80 164C138 151 178 124 209 89Z'],['#d2cbff','#75e6db'],'#171e2b'),
('07','折页','OPEN FOLD','从一个 L 展开空间。实面和折边形成入口，减少内部符号，让形状直接被记住。',[
'M65 53Q65 45 73 48L117 71V161L193 122Q201 118 201 127V170Q201 176 195 179L116 219Q109 222 103 218L69 198Q65 195 65 189Z',
'M117 71L177 40Q184 37 184 45V88Q184 94 178 97L117 128Z'],['#ffede0','#ffb99c'],'#a84032')]
def defs(colors,bg):
 top_end='#a5b1ed' if bg=='#171e2b' else colors[1]
 return f'''<defs><linearGradient id="bg" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="{bg}"/><stop offset="1" stop-color="{bg}"/></linearGradient><linearGradient id="g0" x1="0" y1="1" x2=".8" y2="0"><stop stop-color="{colors[0]}"/><stop offset="1" stop-color="{top_end}"/></linearGradient><linearGradient id="g1" x1="0" y1="1" x2="1" y2="0"><stop stop-color="{colors[1]}"/><stop offset="1" stop-color="{colors[1]}"/></linearGradient><linearGradient id="g2" x2="1" y2="1"><stop stop-color="{colors[-1]}"/><stop offset="1" stop-color="{colors[-1]}"/></linearGradient></defs>'''
def draw(s,mode):
 num,title,en,desc,paths,colors,bg=s
 ds=defs(colors,bg) if mode in ('app','color') else ''
 body='<g id="background"><rect width="256" height="256" fill="url(#bg)"/></g>' if mode=='app' else ''
 body+='<g id="mark">'
 for i,path in enumerate(paths):
  transform=(f' transform="translate({4 if i==0 else -4} {-10 if i==0 else 10})"' if num=='06' else '')
  body+=f'<path d="{path}"{transform} fill="'+(f'url(#g{i})' if mode in ('app','color') else ('#f4f5fa' if mode=='white' else '#20252e'))+'"/>'
 body+='</g>'
 if num=='07' and mode in ('app','color'):
  body+='<g id="fold"><path d="M117 71V161L103 168V66Z" fill="#8f3529" opacity=".18"/><path d="M117 161L193 122Q201 118 201 127V130L117 173Z" fill="#fff" opacity=".18"/></g>'
 view='25 25 206 206' if mode in ('black','white') else '0 0 256 256'
 return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="{view}">{ds}{body}</svg>'
for s in studies:
 d=p/s[0];d.mkdir(exist_ok=True)
 for name,mode in [('app-ios','app'),('brand-color','color'),('menubar-template','black'),('brand-white','white')]:
  svg=draw(s,mode);ET.fromstring(svg);(d/f'{name}.svg').write_text(svg)
rows=[]
for s in studies:
 num,title,en,desc,*_=s
 rows.append(f'''<section><div class="art"><img src="{num}/app-ios.svg" class="icon"></div><div class="copy"><div class="index">{num} / {en}</div><h2>{title}</h2><p>{desc}</p><div class="proof"><img src="{num}/menubar-template.svg" width="70" height="70"><span></span><img src="{num}/menubar-template.svg" width="32" height="32"><img src="{num}/menubar-template.svg" width="18" height="18"><img src="{num}/menubar-template.svg" width="16" height="16"></div><div class="note">同一主形 / 单色 · 32 · 18 · 16 px</div><a href="{num}/app-ios.svg">SVG 原稿 ↗</a></div></section>''')
(p/'new-directions.html').write_text('''<!doctype html><html lang="zh"><meta charset="utf-8"><title>LinkShell — 新方向</title><style>*{box-sizing:border-box}body{margin:0;background:#f8f7f4;color:#282a32;font-family:Geist,-apple-system,BlinkMacSystemFont,sans-serif}.page{max-width:1100px;margin:auto;padding:40px 60px 50px}header{display:flex;justify-content:space-between;align-items:end;padding:0 0 35px}header b{font-size:11px;letter-spacing:3px;font-weight:500;color:#8b8b92}header h1{font-size:27px;font-weight:500;letter-spacing:-1px;margin:12px 0 0}header small{font-size:11px;color:#a1a1a8}section{display:grid;grid-template-columns:1fr 1fr;gap:80px;align-items:center;padding:38px 30px 42px}.art{display:flex;justify-content:center}.icon{width:236px;height:236px;border-radius:53px}.index{font-size:10px;letter-spacing:2px;color:#898b96}h2{font-size:28px;font-weight:500;margin:12px 0}p{font-size:13px;line-height:1.9;color:#83848d;max-width:330px;margin:0 0 10px}.proof{display:flex;align-items:center;gap:22px;height:73px}.proof span{width:15px}.note{font-size:9px;color:#a2a2aa;margin:7px 0 14px}a{font-size:10px;color:#777a88;text-decoration:none}footer{margin-top:20px;font-size:10px;color:#aaa9ad;line-height:1.8}footer a{margin-right:12px}@media(max-width:760px){.page{padding:28px 24px}header small{display:none}section{gap:24px;padding:32px 0}.icon{width:190px;height:190px;border-radius:43px}.proof{gap:12px}.proof span{width:0}h2{font-size:25px}}</style><div class="page"><header><div><b>LINKSHELL / NEW DIRECTIONS</b><h1>从轮廓重新开始。</h1></div><small>原生 SVG · 三个独立方向</small></header>'''+''.join(rows)+'''<footer>视觉研究参考：<a href="https://linear.app/brand">Linear 官方品牌规范</a><a href="https://www.raycast.com/press">Raycast 官方图稿</a><a href="https://arc.net">Arc 官网</a><br>以上为原创主标探索。App 圆角为页面预览；源稿不预画圆角，当前尚未接入产品。</footer></div></html>''')
(p/'reference-notes.md').write_text('''# 本轮视觉研究

官方资料：
- https://linear.app/brand — 观察轮廓、几何节奏、单色和留白。官方规范强调充分留白并偏好单色标志。
- https://www.raycast.com/press — 观察强方向性的标志和 App 图标独立材质处理。官方分别提供 Logo、wordmark、桌面及 iOS 图标。
- https://arc.net — 观察有机曲线和鲜明但协调的配色。

这是设计观察，不是对品牌优劣的客观排名；未复制或修改这些品牌图形。

05：Shell 曲面方向。06：双向流动方向。07：L 折面方向。
所有源图为 SVG。菜单栏保留主形、移除材质；当前是浏览器原尺寸预览，并非系统 template 或真机验收。
''')
print(p.resolve()/'new-directions.html')
