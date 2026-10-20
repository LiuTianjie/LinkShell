from pathlib import Path
from math import hypot,sin,cos,pi,atan2
from xml.etree import ElementTree as ET
p=Path(__file__).parent
studies=[
 dict(id='J',name='舒展 L',desc='收紧上环，放开下弧；交叉后向右上收笔。',start=(55,181),curves=[((87,160),(128,139),(154,104)),((178,71),(169,46),(148,49)),((119,53),(105,89),(108,126)),((111,175),(147,205),(195,169))]),
 dict(id='K',name='连写 LS',desc='一个连续笔势，连接左侧长环和右侧短弯。',start=(65,174),curves=[((89,145),(124,109),(137,75)),((148,48),(125,45),(109,64)),((89,100),(91,148),(114,173)),((138,198),(165,189),(169,168)),((172,144),(141,129),(142,108)),((143,85),(171,84),(186,102))]),
 dict(id='L',name='回锋 S',desc='上部轻收、下部舒展，末端向内部折回。',start=(183,76),curves=[((163,50),(128,49),(107,70)),((87,91),(103,111),(131,122)),((166,136),(182,153),(164,177)),((148,201),(110,204),(84,187)),((63,173),(66,151),(82,142)),((96,134),(115,142),(124,155))])]
def bez(a,b,c,d,t):
 u=1-t
 xy=(u*u*u*a[0]+3*u*u*t*b[0]+3*u*t*t*c[0]+t*t*t*d[0],u*u*u*a[1]+3*u*u*t*b[1]+3*u*t*t*c[1]+t*t*t*d[1])
 der=(3*u*u*(b[0]-a[0])+6*u*t*(c[0]-b[0])+3*t*t*(d[0]-c[0]),3*u*u*(b[1]-a[1])+6*u*t*(c[1]-b[1])+3*t*t*(d[1]-c[1]))
 return xy,der

def outline(s):
 samples=[];a=s['start']
 for seg,(b,c,d) in enumerate(s['curves']):
  for k in range(81):
   if seg and k==0:continue
   t=k/80;xy,der=bez(a,b,c,d,t);length=hypot(*der)
   samples.append((xy,(-der[1]/length,der[0]/length)))
  a=d
 # Pressure changes gently with travel, avoiding abrupt joins.
 radii=[6.1+.6*sin(pi*i/(len(samples)-1))+.5*sin(2*pi*i/(len(samples)-1)) for i in range(len(samples))]
 left=[(v[0][0]+v[1][0]*r,v[0][1]+v[1][1]*r) for v,r in zip(samples,radii)]
 right=[(v[0][0]-v[1][0]*r,v[0][1]-v[1][1]*r) for v,r in zip(samples,radii)]
 pts=left[:]
 xy,n=samples[-1];r=radii[-1];angle=atan2(n[1],n[0])
 pts.extend((xy[0]+r*cos(angle-pi*k/20),xy[1]+r*sin(angle-pi*k/20)) for k in range(1,21))
 pts.extend(right[-2::-1])
 xy,n=samples[0];r=radii[0];angle=atan2(-n[1],-n[0])
 pts.extend((xy[0]+r*cos(angle-pi*k/20),xy[1]+r*sin(angle-pi*k/20)) for k in range(1,21))
 return 'M'+'L'.join(f'{x:.3f} {y:.3f}' for x,y in pts)+'Z'

def skeleton(s):
 return f'M{s["start"][0]} {s["start"][1]}'+''.join('C'+' '.join(f'{x} {y}' for x,y in curve) for curve in s['curves'])

def svg(s,mode):
 defs='''<defs><radialGradient id="bg" cx=".5" cy="-.15" r="1.25"><stop stop-color="#333b3d"/><stop offset=".55" stop-color="#171d1f"/><stop offset="1" stop-color="#101517"/></radialGradient><linearGradient id="ink" x1="0" y1="0" x2=".25" y2="1"><stop stop-color="#ffffff"/><stop offset=".65" stop-color="#f7f8f7"/><stop offset="1" stop-color="#dfe5e4"/></linearGradient></defs>''' if mode=='app' else ''
 bg='<g id="background"><rect width="256" height="256" fill="url(#bg)"/></g>' if mode=='app' else ''
 if mode=='skeleton':
  shape=f'<path id="editable-centerline" d="{skeleton(s)}" fill="none" stroke="#252b30" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>'
 else:
  fill='url(#ink)' if mode=='app' else ('#fff' if mode=='white' else '#252b30')
  shape=f'<path id="outlined-mark" d="{outline(s)}" fill="{fill}"/>'
 view='38 34 176 184' if mode=='template' else '0 0 256 256'
 return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="{view}">{defs}{bg}<g id="mark">{shape}</g></svg>'
for s in studies:
 d=p/s['id'];d.mkdir(exist_ok=True)
 for name,mode in [('app-ios','app'),('brand-light','black'),('brand-dark','white'),('menubar-template','template'),('editable-centerline','skeleton')]:
  data=svg(s,mode);ET.fromstring(data);(d/f'{name}.svg').write_text(data)
rows=[]
for s in studies:
 n=s['id']
 rows.append(f'''<section><div class="icon-shell"><img src="{n}/app-ios.svg" alt="{n} {s['name']}"></div><div class="copy"><div class="number">{n} / SIGNATURE STUDY</div><h2>{s['name']}</h2><p>{s['desc']}</p><div class="proof"><img width="64" height="64" src="{n}/brand-light.svg"><span></span><img width="32" height="32" src="{n}/menubar-template.svg"><img width="18" height="18" src="{n}/menubar-template.svg"><img width="16" height="16" src="{n}/menubar-template.svg"></div><div class="links"><a href="{n}/app-ios.svg">图标 SVG ↗</a><a href="{n}/editable-centerline.svg">可编辑贝塞尔曲线 ↗</a></div></div></section>''')
(p/'index.html').write_text('''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LinkShell · 笔势研究</title><style>*{box-sizing:border-box}body{margin:0;background:#eeedeb;color:#2a2d30;font-family:Geist,-apple-system,BlinkMacSystemFont,sans-serif}.page{max-width:1020px;margin:auto;padding:36px 62px 38px}header{margin-bottom:28px}.eyebrow{font-size:10px;color:#97989b;letter-spacing:3px}h1{font-size:28px;font-weight:500;letter-spacing:-1px;margin:10px 0}header p{font-size:11px;color:#9a9a9c;margin:0}section{display:grid;grid-template-columns:1fr 1fr;gap:90px;align-items:center;padding:28px 34px}.icon-shell{width:240px;height:240px;border-radius:57px;padding:1.5px;background:linear-gradient(160deg,#596263,#283032 30%,#11191b 70%,#465051);box-shadow:0 15px 25px -20px #11212545}.icon-shell img{display:block;width:100%;height:100%;border-radius:55.5px}.number{font-size:9px;letter-spacing:1.8px;color:#94979b}h2{font-size:26px;font-weight:500;margin:12px 0}.copy p{font-size:12px;line-height:1.8;color:#929498;margin:0}.proof{display:flex;align-items:center;gap:17px;margin:17px 0;height:64px}.proof span{width:5px}.links{display:flex;gap:20px}.links a{font-size:10px;color:#95989c;text-decoration:none}footer{font-size:9px;color:#aaa9ab;margin-top:24px}@media(max-width:760px){.page{padding:28px}.icon-shell{width:215px;height:215px;border-radius:51px}.icon-shell img{border-radius:49.5px}section{gap:38px;padding:26px 0}.proof{gap:12px}.links{gap:12px}.links a{font-size:9px}}@media(max-width:520px){section{grid-template-columns:1fr;gap:28px;padding:28px 0 36px}.icon-shell{margin:auto}.copy{text-align:center}.proof,.links{justify-content:center}}</style><main class="page"><header><div class="eyebrow">LINKSHELL / SIGNATURE STUDIES</div><h1>先把一笔画好。</h1><p>同一底板、同一光线。比较曲线、留白和收笔。</p></header>'''+''.join(rows)+'''<footer>SVG 矢量候选 / 主图源稿不预画圆角 / 同时提供可编辑中心线与实心轮廓 / 小尺寸为浏览器预览</footer></main></html>''')
(p/'README.md').write_text('''# 笔势研究

依据用户提供的手写环形图标参考，探索 L、LS、S 三种连续笔势。index.html 为预览。

各候选提供：
- app-ios.svg：1024 方形、不预画圆角；底板与笔迹分组。
- editable-centerline.svg：少量三次贝塞尔段，可直接调整控制点；匀线宽编辑稿。
- brand-light.svg / brand-dark.svg：从中心线生成带轻微笔压变化的实心矢量轮廓。
- menubar-template.svg：黑色实心路径与透明背景。

页面边缘光和圆角仅为 App 图标展示效果。尚未接入产品或完成系统与真机验收。
''')
print(p.resolve()/'index.html')
