from pathlib import Path
from xml.etree import ElementTree as ET
p=Path(__file__).parent
original=[
'M43 170C69 145 82 101 105 61C113 47 124 46 132 60L144 81C120 107 108 145 98 199C78 192 58 180 43 170Z',
'M112 190C139 133 178 95 218 72C202 123 168 164 112 190Z']
balanced=[
'M45 170C71 145 84 103 106 63C114 49 125 49 133 62L143 80C120 107 109 146 99 198C79 192 60 181 45 170Z',
'M113 190C139 137 176 99 214 77C199 125 166 164 113 190Z']
variants=[
 dict(id='A',title='均衡',desc='保留原版性格，收住右侧尖端，微调两片的重量。',paths=balanced),
 dict(id='B',title='修长',desc='主片略窄、尖端略高，整体更轻。',paths=[
'M51 175C77 145 89 99 111 58C118 45 126 46 133 59L142 76C122 107 112 147 104 201C86 195 68 186 51 175Z',
'M119 191C145 135 179 91 216 65C203 116 170 159 119 191Z']),
 dict(id='C',title='聚拢',desc='缩小两片间的距离，让小尺寸下的整体感更强。',paths=[
'M47 170C73 145 85 104 107 64C115 51 125 51 133 64L143 82C121 108 111 147 101 198C82 191 62 180 47 170Z',
'M108 190C132 139 164 103 201 80C189 124 160 163 108 190Z']),
 dict(id='D',title='柔和',desc='放圆右片尖端，主片过渡更舒展。',paths=[
'M46 168C71 143 84 103 105 65C114 49 127 49 136 65L144 80C122 108 111 147 100 198C80 192 59 181 46 168Z',
'M114 190C137 140 171 105 207 82C214 78 217 81 214 89C197 132 163 167 114 190Z']),
 dict(id='E',title='掠过',desc='主片更倾斜，右片向外舒展，方向感更明显。',paths=[
'M39 166C67 144 82 111 108 70C117 55 127 55 136 69L148 87C121 110 108 145 97 194C76 188 55 177 39 166Z',
'M111 184C144 139 180 112 222 93C202 137 166 167 111 184Z']),
 dict(id='F',title='夜色',desc='与 A 使用同一轮廓，只比较深底和蓝青配色。',paths=balanced,dark=True)
]
light_bg=('#edf0f8','#e2e8f3')
light_colors=[('#4569dc','#6784ee'),('#7b9ef0','#a4c6fb')]
def svg(paths,mode='app',dark=False):
 bg=('#242e46','#111c31') if dark else light_bg
 colors=[('#9bb4f8','#d4e1ff'),('#69cfd8','#a1e8e4')] if dark else light_colors
 defs=''
 if mode in ('app','color'):
  defs='<defs>'+f'<linearGradient id="bg" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="{bg[0]}"/><stop offset="1" stop-color="{bg[1]}"/></linearGradient>'
  for i,(a,b) in enumerate(colors):
   defs+=f'<linearGradient id="g{i}" x1="0" y1="1" x2=".8" y2="0"><stop stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>'
  defs+='</defs>'
 body='<g id="background"><rect width="256" height="256" fill="url(#bg)"/></g>' if mode=='app' else ''
 body+='<g id="mark">'
 for i,path in enumerate(paths):
  fill=f'url(#g{i})' if mode in ('app','color') else ('#f4f6fb' if mode=='white' else '#252a34')
  body+=f'<path d="{path}" fill="{fill}"/>'
 body+='</g>'
 view='20 20 216 216' if mode=='template' else '0 0 256 256'
 return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="{view}">{defs}{body}</svg>'
for v in variants+[dict(id='original',paths=original)]:
 d=p/v['id'];d.mkdir(exist_ok=True)
 for name,mode in [('app-ios','app'),('brand-color','color'),('brand-light','black'),('brand-dark','white'),('menubar-template','template')]:
  data=svg(v['paths'],mode,v.get('dark',False));ET.fromstring(data);(d/f'{name}.svg').write_text(data)
rows=[]
for v in variants:
 n=v['id']
 rows.append(f'''<article><div class="artline"><div class="app"><img class="colored" src="{n}/app-ios.svg" alt="09{n} {v['title']}"><img class="silhouette" src="{n}/brand-light.svg" alt="09{n} 单色轮廓"></div><div class="spec"><img class="large" src="{n}/brand-light.svg"><div class="sizes"><img src="{n}/menubar-template.svg" width="32" height="32"><img src="{n}/menubar-template.svg" width="18" height="18"><img src="{n}/menubar-template.svg" width="16" height="16"></div><small>32 / 18 / 16 px</small></div></div><div class="label"><span>09{n}</span><h2>{v['title']}</h2><a href="{n}/app-ios.svg">SVG ↗</a></div><p>{v['desc']}</p></article>''')
html='''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LinkShell · 09 燕尾迭代</title><style>*{box-sizing:border-box}body{margin:0;background:#f7f6f3;color:#2c2d35;font-family:Geist,-apple-system,BlinkMacSystemFont,sans-serif}.page{max-width:1100px;margin:auto;padding:38px 48px 40px}header{display:flex;justify-content:space-between;align-items:center;gap:28px;margin-bottom:30px}.eyebrow{font-size:10px;letter-spacing:2.5px;color:#92919a}h1{font-size:28px;font-weight:500;letter-spacing:-.7px;margin:10px 0 7px}.intro{font-size:11px;color:#9997a0;margin:0}.original{display:flex;align-items:center;gap:15px}.original .app{width:68px;height:68px;border-radius:15px}.original span{font-size:10px;color:#96949e;line-height:1.8}.controls{display:flex;align-items:center;justify-content:space-between;margin-bottom:34px}.toggle{display:flex;background:#ecebe8;border-radius:99px;padding:4px;gap:3px}button{font:inherit;font-size:10px;border:0;border-radius:99px;padding:7px 14px;color:#92909a;background:transparent;cursor:pointer}button[aria-pressed=true]{background:#fff;color:#45434e;box-shadow:0 1px 6px #302d3510}button:focus-visible{outline:2px solid #8393ca;outline-offset:2px}.controls>small{font-size:10px;color:#aaa6ad}.grid{display:grid;grid-template-columns:1fr 1fr;gap:40px 70px}.artline{display:flex;align-items:center;justify-content:space-between;gap:22px}.app{position:relative;width:200px;height:200px;border-radius:44px;background:#e9edf5;overflow:hidden;flex-shrink:0}.app img{width:100%;height:100%;display:block}.app .silhouette{display:none}.mono-view .app .colored{display:none}.mono-view .app .silhouette{display:block}.spec{text-align:center;width:130px}.large{width:75px;height:75px}.sizes{display:flex;align-items:center;justify-content:center;gap:17px;height:34px;margin-top:17px}.spec small{display:block;font-size:9px;color:#aaa6af;margin-top:9px}.label{display:flex;align-items:baseline;gap:12px;margin-top:19px}.label span{font-size:11px;color:#98949f}.label h2{font-size:18px;font-weight:500;margin:0}.label a{font-size:10px;color:#9b98a2;margin-left:auto;text-decoration:none}article p{font-size:11px;line-height:1.8;color:#8c8894;margin:8px 0 0}footer{font-size:9px;color:#a8a4af;margin-top:34px}footer a{color:inherit}@media(max-width:950px){.page{padding:28px}.grid{gap:35px 36px}.app{width:170px;height:170px;border-radius:38px}.spec{width:110px}.artline{gap:12px}.sizes{gap:12px}.large{width:64px;height:64px}}@media(max-width:650px){.grid{grid-template-columns:1fr;gap:36px}.app{width:210px;height:210px;border-radius:47px}.spec{width:125px}.original{gap:8px}.original .app{width:52px;height:52px;border-radius:12px}.original span{display:none}h1{font-size:25px}.intro{max-width:245px;line-height:1.6}.controls>small{max-width:130px;text-align:right;line-height:1.6}}</style><div class="page"><header><div><div class="eyebrow">LINKSHELL / SWALLOW STUDIES</div><h1>09 燕尾 · 六个迭代</h1><p class="intro">保留双片上扬的轮廓。A—E 比较形状，F 比较配色。</p></div><div class="original"><div class="app"><img class="colored" src="original/app-ios.svg"><img class="silhouette" src="original/brand-light.svg"></div><span>09<br>原版</span></div></header><div class="controls"><div class="toggle" role="group" aria-label="预览模式"><button type="button" data-mode="color" aria-pressed="true">彩色</button><button type="button" data-mode="mono" aria-pressed="false">单色轮廓</button></div><small>同一画布比例 · 相同光线方向</small></div><main class="grid">'''+''.join(rows)+'''</main><footer>可编辑 SVG / 圆角只用于系统裁切预览 / 小尺寸为浏览器预览 · <a href="../more-directions.html">回看上一轮</a></footer></div><script>document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{document.body.classList.toggle('mono-view',button.dataset.mode==='mono');document.querySelectorAll('[data-mode]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)))}));</script></html>'''
(p/'index.html').write_text(html)
(p/'README.md').write_text('''# 09 燕尾迭代

由用户选中的 09 派生的六个候选，original 目录保留同一轮廓与配色。

- A 均衡：收短右侧尖端，微调主片弧度。
- B 修长：主片更窄、起点更高。
- C 聚拢：缩小片间距与右片展开范围。
- D 柔和：放圆右片尖端。
- E 掠过：更向右倾斜的主片与展开的副片。
- F 夜色：与 A 路径完全相同，只改变背景与主体色。

A—E 沿用原版背景与渐变色，用于比较形状；F 用于比较深色方向。
每个目录包含 app-ios.svg、brand-color.svg、brand-light.svg、brand-dark.svg、menubar-template.svg。背景、主体分组，主图不预置圆角，单色版使用填充路径。index.html 支持彩色与单色轮廓切换，并展示 32/18/16 px。当前是选型稿与浏览器预览，未替换产品资源，未完成平台系统或真机验收。
''')
print(p.resolve()/'index.html')
