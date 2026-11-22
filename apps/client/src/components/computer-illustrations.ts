// Original family silhouettes. The materials are illustrative; the host doesn't report a finish.
const svg = (box: string, content: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${content}</svg>`;
function metal(id: string, stops: string[], horizontal = false) {
  return `<linearGradient id="${id}" x2="${horizontal ? '100%' : '0%'}" y2="${horizontal ? '0%' : '100%'}">${stops.map((c, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient>`;
}
function notebook(pro: boolean) {
  const x = pro ? 43 : 52, y = pro ? 7 : 16, w = 400 - x * 2, hinge = 201;
  const keyX = pro ? 59 : 43, keyW = (400 - 2 * keyX) / 14;
  const keys = Array.from({ length: 5 }, (_, r) => {
    const scale = 0.90 + r * 0.021, keyY = 207 + r * 4.3;
    return Array.from({ length: 14 }, (_, c) => {
      if (r === 4 && c > 3 && c < 10) return '';
      return `<rect x="${200 + (keyX + c * keyW - 200) * scale}" y="${keyY}" width="${(r === 4 && c === 3 ? 7 : 1) * keyW * scale - 1.5}" height="3.3" rx="0.9" fill="${pro ? '#30343a' : '#373d45'}"/>`;
    }).join('');
  }).join('');
  return svg('0 0 400 256', `<defs>
    ${metal('lid', pro ? ['#b1b5bc','#494e55','#262a30'] : ['#e1e5e8','#7d878d','#929ba3'])}
    ${metal('deck', pro ? ['#606770','#9198a0','#767d87'] : ['#a6afb6','#e3e7e9','#c4cbd0'])}
    ${metal('lip', pro ? ['#aeb5bc','#6b727c','#32373e'] : ['#f7f9fa','#a0a8af','#69747e'])}
    ${metal('glass', pro ? ['#254568','#12253d','#0b1525'] : ['#91b6c8','#537993','#152b41'])}
    ${metal('wave', pro ? ['#52708c','#243c58','#111f33'] : ['#bfd4d9','#698da5','#2e4b64'])}
    <clipPath id="panel"><rect x="${x+5}" y="${y+5}" width="${w-10}" height="${hinge-y-15}" rx="4"/></clipPath></defs>
    <rect x="${x}" y="${y}" width="${w}" height="${hinge-y}" rx="8" fill="url(#lid)"/>
    <rect x="${x+1.7}" y="${y+1.7}" width="${w-3.4}" height="${hinge-y-3}" rx="7" fill="#11151a"/>
    <g clip-path="url(#panel)"><rect x="${x}" y="${y}" width="${w}" height="195" fill="url(#glass)"/>
    <path d="${pro ? 'M15 62 Q96 130 187 73 T389 39 L389 211 L15 211Z' : 'M18 148 Q102 79 191 102 T383 47 L381 209 L18 209Z'}" fill="url(#wave)"/>
    <path d="${pro ? 'M12 114 Q106 179 220 110 T389 91 L389 211 L12 211Z' : 'M16 156 Q129 113 211 143 T383 96 L383 211 L16 211Z'}" fill="url(#glass)"/></g>
    <path d="M188 ${y+4}h24v3q0 2-2 2h-20q-2 0-2-2Z" fill="#11151a"/>
    <path d="M${x} ${hinge-2}H${400-x}L389 241Q390 243 386 244H14Q10 243 11 241Z" fill="url(#deck)" stroke="${pro ? '#69717a' : '#a0aab0'}" stroke-width="1"/>
    <path d="M${x+15} 200H${400-x-15}l2 2H${x+13}Z" fill="#30363c"/>
    ${pro ? '<path d="M65 205h270l12 23H53Z" fill="#252b32"/>' : ''}${keys}
    <path d="M151 230h98l3 10H148Z" fill="none" stroke="${pro ? '#5c636c' : '#9ba5ad'}" stroke-width=".8"/>
    <path d="M11 242q3 1 8 1h362q6 0 8-1v${pro?4:1}q-2 ${pro?5:3}-12 ${pro?5:3}H23q-11 0-12-${pro?5:3}Z" fill="url(#lip)"/>
    <path d="M177 243h46l-2 2h-42Z" fill="${pro ? '#555c64' : '#969fa8'}"/>`);
}

const studio = svg('0 0 320 214', `<defs>${metal('top',['#f4f5f6','#cacdd0','#afb2b5'],true)}${metal('face',['#989da1','#d9dcde','#babdc0','#808589'],true)}</defs>
  <path d="M29 66Q28 49 49 45l193-21q22-2 31 12l20 37v75q0 14-17 18l-190 27q-20 2-30-8L29 157Z" fill="url(#face)"/>
  <path d="M29 65q-2-12 18-16l195-22q20-2 27 10l20 29q8 12-11 15L89 107q-20 3-30-7Z" fill="url(#top)" stroke="#c2c5c8"/>
  <path d="M64 177q10 11 26 8l191-27" fill="none" stroke="#eceeef" stroke-opacity=".55"/>
  <g fill="#353b40" transform="matrix(1,-.135,0,1,0,25)"><rect x="110" y="129" width="12" height="4" rx="2"/><rect x="128" y="129" width="12" height="4" rx="2"/><rect x="220" y="130" width="27" height="2.5" rx="1"/></g>`);

// No display, keyboard or stand: unknown hardware must not read as an iMac or a Mac mini.
const unknown = svg('0 0 160 128', `<g transform="translate(46 31)" stroke="#89929c" stroke-width="2.5" stroke-linecap="round" fill="none">
  ${Array.from({length: 4}, (_, i) => { const p = 16+i*11; return `<path d="M${p} 3V-4M${p} 63v7M3 ${p}h-7M63 ${p}h7"/>`; }).join('')}
  <rect x="3" y="3" width="60" height="60" rx="10" fill="#dce0e4"/><rect x="12" y="12" width="42" height="42" rx="5" stroke="#a4adb5"/>
  <path d="m21 27 7 6-7 6m13 0h9" stroke="#626e7a" stroke-width="3" stroke-linejoin="round"/></g>`);

export const computerIllustrations = { air: notebook(false), pro: notebook(true), studio, unknown };
