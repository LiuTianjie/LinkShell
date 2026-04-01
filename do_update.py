with open("docs/site/index.html", "r", encoding="utf-8") as f:
    text = f.read()

start_idx = text.find('    <!-- Quickstart -->')
end_idx = text.find('    <!-- Final CTA -->')

if start_idx != -1 and end_idx != -1:
    new_qs = """    <!-- Quickstart -->
    <section class="max-w-5xl mx-auto px-6 mb-24" id="quickstart">
      <h2 class="text-3xl md:text-4xl font-bold tracking-tight mb-16 text-center" data-i18n="howItWorksTitle">只需三步，连接你的终端</h2>
      
      <div class="grid grid-cols-1 xl:grid-cols-3 gap-8">
        <!-- Step 1 -->
        <div class="bento-card relative">
          <div class="absolute -top-5 left-6 w-10 h-10 rounded-xl bg-brand text-white flex items-center justify-center font-bold text-lg shadow-lg">1</div>
          <h3 class="font-bold text-lg mb-3 mt-2" data-i18n="step1Title">部署 Gateway</h3>
          <p class="text-sm text-muted mb-4" data-i18n="step1Desc">基于 Docker 轻松部署。公网机器充当信令与 WebSocket 中转，安全无留存。</p>
          <div class="bg-brand text-white font-mono text-xs p-4 rounded-xl space-y-2 overflow-x-auto shadow-inner h-[280px] flex flex-col justify-center">
            <div class="text-gray-400"># 使用 Docker 启动网关</div>
            <div class="text-green-400">$ <span class="text-white">git clone https://.../linkshell</span></div>
            <div class="text-green-400">$ <span class="text-white">cd linkshell/packages/gateway</span></div>
            <div class="text-green-400">$ <span class="text-white">docker compose up -d</span></div>
            <div class="text-gray-400 mt-3"># 验证连通性</div>
            <div class="text-gray-300">curl http://127.0.0.1:8787/healthz</div>
            <div class="text-emerald-300 mt-1">{"status":"ok"}</div>
          </div>
        </div>

        <!-- Step 2 -->
        <div class="bento-card relative">
          <div class="absolute -top-5 left-6 w-10 h-10 rounded-xl bg-brand text-white flex items-center justify-center font-bold text-lg shadow-lg">2</div>
          <h3 class="font-bold text-lg mb-3 mt-2" data-i18n="step2Title">终端打印对接码</h3>
          <p class="text-sm text-muted mb-4" data-i18n="step2Desc">全局安装并直接桥接你的 AI 代理进程，终端会直接打印二维码以供扫描。</p>
          <div class="bg-brand text-white font-mono text-xs p-4 rounded-xl space-y-1.5 overflow-x-auto shadow-inner h-[280px]">
            <div class="text-gray-400"># 安装并体检环境</div>
            <div class="text-green-400">$ <span class="text-white">npm i -g @linkshell/cli</span></div>
            <div class="text-gray-400 mt-1"># 桥接工作流</div>
            <div class="text-green-400">$ <span class="text-white">linkshell start</span></div>
            <div class="text-gray-300 mt-2 leading-[8px] text-[8px] sm:text-[10px] sm:leading-[10px] font-black">
██████████████████████████████<br>
██ ▄▄▄▄▄ ██▄▄▀▄ ▄█▄█ ▄▄▄▄▄ ██<br>
██ █   █ ████▀█▀▄ ▀█ █   █ ██<br>
██ █▄▄▄█ ██   █▄█▀▄█ █▄▄▄█ ██<br>
██▄▄▄▄▄▄▄█▄█▄█▄▀▄▀▄█▄▄▄▄▄▄▄██<br>
██▄█▄▀  ▄▄▄█▄  █▀ ▀█ █▀  ▀ ██<br>
██  █▀█▀▄▄ ▄▄   ▀███▄▄██▀▀▄██<br>
██▄▄▄▄▄▄▄█ ▄█▄██  ██▄ ▀▄ ▄▄██<br>
██ ▄▄▄▄▄ █▄█ ▀ █▀█ █ ▀█ █▀ ██<br>
██ █   █ █ ▀ ▄██▄█▄█▀█▄▀█████<br>
██ █▄▄▄█ █ ▄▀█  ██▄▄  ▀▄▀▄███<br>
██▄▄▄▄▄▄▄█▄████▄█▄▄██████▄███<br>
██████████████████████████████
            </div>
            <div class="text-emerald-300 mt-1 font-semibold text-[10px]">➜ Code: <span class="bg-emerald-900 px-1 rounded text-white tracking-widest">847293</span></div>
          </div>
        </div>

        <!-- Step 3 -->
        <div class="bento-card relative border-2 border-brand shadow-xl">
          <div class="absolute -top-5 left-6 w-10 h-10 rounded-xl border-2 border-brand bg-white text-brand flex items-center justify-center font-bold text-lg shadow-lg">3</div>
          <h3 class="font-bold text-lg mb-3 mt-2 text-brand" data-i18n="step3Title">手机扫码，即刻接管</h3>
          <p class="text-sm text-muted mb-4" data-i18n="step3Desc">用 Expo App 相机直接对准终端上的二维码一扫（或手动填码）即可获取控制特权。</p>
          <div class="bg-surface border-2 border-brand/20 font-mono text-sm p-4 rounded-xl flex flex-col items-center justify-center h-[280px] overflow-hidden relative">
            <div class="absolute inset-0 bg-brand/5"></div>
            
            <!-- 扫码动效演示 -->
            <div class="relative w-28 h-28 mb-4">
              <div class="absolute inset-0 bg-white border-2 border-gray-200 rounded-xl p-3 shadow-sm flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full text-brand opacity-90"><path d="M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm13-2h-3v2h3zm-3 2h-2v2h2zm2 2h3v-2h-3zm-2 2h-2v2h2zm2 0v2h3v-2h-3z"/></svg>
              </div>
              <div class="absolute inset-0 border-[3px] border-brand rounded-xl scale-105 pointer-events-none opacity-50"></div>
              
              <!-- 扫描线 -->
              <div class="absolute top-0 left-0 w-full h-[2px] bg-brand shadow-[0_0_12px_3px_rgba(0,0,0,0.4)] animate-[scan_2.5s_ease-in-out_infinite] shadow-brand"></div>
            </div>

            <div class="text-brand mb-2 text-xs uppercase font-bold tracking-widest text-center relative z-10 bg-white/80 px-2 py-0.5 rounded">正在扫描终端终端码...</div>
            <div class="flex gap-1.5 text-xl font-bold tracking-widest text-brand bg-white px-3 py-2 rounded-lg shadow-sm border border-brand/30 relative z-10">
              <span class="px-1 border-b-2 border-brand opacity-100">8</span>
              <span class="px-1 border-b-2 border-brand opacity-100">4</span>
              <span class="px-1 border-b-2 border-brand opacity-40">7</span>
              <span class="text-gray-300">-</span>
              <span class="px-1 border-b-2 border-brand opacity-20">2</span>
              <span class="px-1 border-b-2 border-brand opacity-20">9</span>
              <span class="px-1 border-b-2 border-brand opacity-20">3</span>
            </div>
          </div>
        </div>
      </div>
    </section>\n\n"""
    text = text[:start_idx] + new_qs + text[end_idx:]
    print("Replaced!")
else:
    print("Failed to find boundaries!")
    print(f"start_idx: {start_idx}, end_idx: {end_idx}")

if '@keyframes scan' not in text:
    text = text.replace('  </style>', '''
    @keyframes scan {
      0% { top: -5%; opacity: 0; }
      10% { opacity: 1; }
      90% { opacity: 1; }
      100% { top: 105%; opacity: 0; }
    }
  </style>''')
    print("Added scanning animation!")

with open("docs/site/index.html", "w", encoding="utf-8") as f:
    f.write(text)
