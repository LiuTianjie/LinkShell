from pathlib import Path
from xml.etree import ElementTree as ET
p=Path(__file__).parent
# Each design has its own filled contours; the template does not depend on strokes or masks.
studies=[
 dict(id='08',name='流门',en='PORTAL',desc='开放的拱面，末端向内收拢。',bg=('#22304f','#101e35'),colors=[('#e8f5ff','#90bdf4')],paths=[
 'M61 194V108C61 63 86 37 128 37C169 37 194 62 194 105V156C194 188 175 208 144 215V185C160 181 166 171 166 154V106C166 80 152 65 128 65C103 65 89 80 89 108V177Z']),
 dict(id='09',name='燕尾',en='SWALLOW',desc='一片上扬、一片舒展，留出轻盈的间隙。',bg=('#edf0f8','#e2e8f3'),colors=[('#4569dc','#6784ee'),('#7b9ef0','#a4c6fb')],paths=[
 'M43 170C69 145 82 101 105 61C113 47 124 46 132 60L144 81C120 107 108 145 98 199C78 192 58 180 43 170Z',
 'M112 190C139 133 178 95 218 72C202 123 168 164 112 190Z']),
 dict(id='10',name='回折',en='SOFT SHIFT',desc='宽线折成 S，圆弧与斜切端点形成对比。',bg=('#694fd0','#44318d'),colors=[('#faf0ff','#d4ccff')],paths=[
 'M194 45H108C69 45 47 66 47 97C47 125 67 141 104 150L142 159C157 163 164 169 164 177C164 186 154 192 139 192H73L49 219H144C181 219 206 201 206 173C206 144 184 129 149 121L109 111C94 107 87 101 87 93C87 84 96 78 110 78H170Z']),
 dict(id='11',name='流隙',en='CONFLUENCE',desc='两片弧面之间，一道弯曲的光隙。',bg=('#25283c','#161a29'),colors=[('#f6d5ae','#f0a194'),('#cdabf4','#969ee8')],transform='rotate(-28 128 128)',paths=[
 'M120 48C78 52 48 85 48 128C48 171 80 205 120 208C163 161 77 95 120 48Z',
 'M136 48C178 52 208 85 208 128C208 171 176 205 136 208C179 161 93 95 136 48Z']),
 dict(id='12',name='栖点',en='RENDEZVOUS',desc='厚薄变化的环，和独立的一枚端点。',bg=('#eaf2e9','#dee9df'),colors=[('#29685c','#4f8c74'),('#87b89a','#a3ceb0')],paths=[
 'M183 91C165 67 128 60 99 79C70 97 63 131 79 158C95 184 127 193 153 181C168 174 178 161 182 145L211 158C205 181 188 201 165 211C125 229 78 214 54 175C29 134 42 82 84 57C124 33 177 44 203 79Z',
 'M197 100L216 111L205 132L184 121Z']),
 dict(id='13',name='帆面',en='SAIL',desc='柔软的负空间，包在一片干净的曲面里。',bg=('#d55d50','#b24540'),colors=[('#fff0df','#ffd1b3')],paths=[
 'M49 184C64 125 106 77 190 45C199 42 208 49 206 59C197 133 148 188 66 209C54 212 46 203 49 191ZM83 177C130 156 163 124 179 84C131 106 99 137 83 177Z']),
 dict(id='14',name='折光',en='PRISM',desc='三片折面围出中心，颜色只落在各自的面上。',bg=('#edf0f4','#e3e6ee'),colors=[('#7995ee','#b6c6f6'),('#3d5baf','#6c85ce'),('#829ee3','#aac9ee')],paths=[
 'M128 39L212 89L128 138L44 89Z',
 'M44 105L119 149V219L44 174Z',
 'M137 149L212 105V174L137 219Z']),
 dict(id='15',name='涟线',en='RESONANCE',desc='三条宽线沿同一个弯道，逐层向内收束。',bg=('#174a52','#15343e'),colors=[('#b8eedc','#c7f5e6'),('#7dcac9','#a1e3d9'),('#57a4ba','#7bc8d4')],paths=[
 'M49 193V106C49 59 78 33 123 33C170 33 203 62 207 105L183 109C179 80 158 57 124 57C91 57 73 75 73 107V181Z',
 'M91 205V109C91 87 105 73 126 73C150 73 165 89 165 112V146C165 162 174 170 190 171V194C159 193 141 175 141 147V112C141 102 135 96 126 96C118 96 114 102 114 111V194Z',
 'M127 212V169C140 192 162 205 191 207V228C162 228 142 222 127 212Z'])]
def render(s,mode):
 colored=mode in ('app','color')
 ds=''
 if colored:
  ds='<defs><linearGradient id="bg" x1="0" y1="0" x2=".7" y2="1">'+f'<stop stop-color="{s["bg"][0]}"/><stop offset="1" stop-color="{s["bg"][1]}"/></linearGradient>'
  for i,(a,b) in enumerate(s['colors']):
   ds+=f'<linearGradient id="g{i}" x1="0" y1="1" x2=".8" y2="0"><stop stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>'
  ds+='</defs>'
 body='<g id="background"><rect width="256" height="256" fill="url(#bg)"/></g>' if mode=='app' else ''
 transform=f' transform="{s["transform"]}"' if 'transform' in s else ''
 body+=f'<g id="mark"{transform}>'
 for i,path in enumerate(s['paths']):
  fill=f'url(#g{i})' if colored else ('#f5f6fa' if mode=='white' else '#252a34')
  body+=f'<path d="{path}" fill="{fill}" fill-rule="evenodd"/>'
 body+='</g>'
 view='20 20 216 216' if mode in ('black','white') else '0 0 256 256'
 return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="{view}">{ds}{body}</svg>'
for s in studies:
 d=p/s['id'];d.mkdir(exist_ok=True)
 for name,mode in [('app-ios','app'),('brand-color','color'),('brand-light','black'),('brand-dark','white'),('menubar-template','black')]:
  xml=render(s,mode);ET.fromstring(xml);(d/f'{name}.svg').write_text(xml)
items=[]
for s in studies:
 n=s['id']
 items.append(f'''<article><div class="main"><img class="app" src="{n}/app-ios.svg" alt="{n} {s['name']}"><div class="spec"><img class="mono" src="{n}/menubar-template.svg" alt="单色标"><div class="minis"><img width="32" height="32" src="{n}/menubar-template.svg"><img width="18" height="18" src="{n}/menubar-template.svg"><img width="16" height="16" src="{n}/menubar-template.svg"></div><span>32 / 18 / 16 px</span></div></div><div class="label"><b>{n}</b><h2>{s['name']}</h2><small>{s['en']}</small><a href="{n}/app-ios.svg">SVG ↗</a></div><p>{s['desc']}</p></article>''')
(p/'more-directions.html').write_text('''<!doctype html><html lang="zh"><meta charset="utf-8"><title>LinkShell · 图标探索 08—15</title><style>*{box-sizing:border-box}body{margin:0;background:#f7f6f3;color:#2c2d35;font-family:Geist,-apple-system,BlinkMacSystemFont,sans-serif}.page{max-width:1160px;margin:auto;padding:44px 50px 48px}header{display:flex;align-items:end;justify-content:space-between;padding-bottom:44px}.eyebrow{font-size:10px;letter-spacing:3px;color:#909098}h1{font-size:29px;font-weight:500;margin:12px 0 0;letter-spacing:-1px}header a{font-size:11px;color:#8a8a95;text-decoration:none}.grid{display:grid;grid-template-columns:1fr 1fr;column-gap:82px;row-gap:48px}.main{display:flex;align-items:center;justify-content:space-between;gap:28px;padding-right:12px}.app{width:208px;height:208px;border-radius:46px}.spec{width:140px;text-align:center}.mono{width:78px;height:78px}.minis{display:flex;align-items:center;justify-content:center;gap:18px;margin-top:23px;height:34px}.spec span{display:block;font-size:9px;color:#a6a5ac;margin-top:12px}.label{display:flex;align-items:baseline;gap:11px;margin-top:22px}.label b{font-size:11px;color:#9a99a3;font-weight:400}.label h2{font-size:18px;font-weight:500;margin:0}.label small{font-size:9px;color:#a6a5ac;letter-spacing:1px}.label a{margin-left:auto;font-size:10px;color:#9a99a3;text-decoration:none}p{font-size:11px;color:#898993;margin:9px 0 0;line-height:1.7}footer{margin-top:40px;font-size:10px;color:#a7a5ac}@media(max-width:1000px){.page{padding:30px}.grid{column-gap:40px}.app{width:170px;height:170px;border-radius:38px}.spec{width:110px}.main{gap:15px;padding:0}.minis{gap:12px}.mono{width:65px;height:65px}}@media(max-width:680px){.grid{grid-template-columns:1fr;row-gap:42px}.page{padding:26px}.app{width:210px;height:210px;border-radius:47px}.spec{width:125px}.label small{font-size:8px}h1{font-size:25px}header{padding-bottom:32px}header a{max-width:90px;line-height:1.5}}</style><div class="page"><header><div><div class="eyebrow">LINKSHELL / EXPLORATION 08—15</div><h1>八种新的轮廓。</h1></div><a href="new-directions.html">回看 05—07 ↗</a></header><div class="grid">'''+''.join(items)+'''</div><footer>可编辑 SVG / 页面圆角仅作系统裁切预览 / 单色与小尺寸为浏览器预览</footer></div></html>''')
(p/'08-15-notes.md').write_text('''# 08—15 主标探索

预览：more-directions.html。

每个编号目录包含 app-ios.svg、brand-color.svg、brand-light.svg、brand-dark.svg、menubar-template.svg。SVG 主图为 1024 × 1024 满画布，没有预置圆角；背景与主体分组。单色稿仅含实心路径，无底板、滤镜或渐变。尺寸展示为浏览器预览，尚未完成平台系统或真机验收。

本轮是用于选方向的矢量提案，未替换产品资源。此前提案保留。
''')
print(p.resolve()/'more-directions.html')
