with open("docs/site/index.html", "r", encoding="utf-8") as f:
    content = f.read()

start_marker = "<!-- Lifestyle Section -->"
end_marker = "<!-- Technical Details -->"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

print(f"start_idx: {start_idx}, end_idx: {end_idx}")

if start_idx != -1 and end_idx != -1:
    new_section = """<!-- Lifestyle Section -->
    <section class="max-w-7xl mx-auto px-6 mb-32 group">
      <div class="mb-16 text-center">
        <h2 class="text-3xl md:text-5xl font-bold tracking-tight mb-6" data-i18n="lifestyleSectionTitle">LinkShell 工作流</h2>
        <p class="text-muted text-lg md:text-xl max-w-2xl mx-auto font-medium" data-i18n="lifestyleLead">不仅是远程命令行桥接；更是打破工位束缚的极客探索。</p>
      </div>
      
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 relative">
        <!-- 装饰性背景光晕 -->
        <div class="absolute -inset-4 bg-brand/5 blur-3xl -z-10 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-1000"></div>
        
        <!-- Card 1 -->
        <div class="bg-surface border border-border rounded-[2rem] p-10 hover:shadow-2xl hover:shadow-brand/5 transition-all duration-500 hover:-translate-y-2">
          <div class="w-16 h-16 rounded-2xl bg-brand/5 border border-border flex items-center justify-center mb-8 text-3xl group-hover:scale-110 transition-transform duration-500">
            🏔️
          </div>
          <h3 class="text-2xl font-bold mb-4" data-i18n="l1Title">挂起并离开</h3>
          <p class="text-muted leading-relaxed" data-i18n="l1Desc">编译、构建、拉镜像... 常驻任务在桌面上飞速运转。你可以去喝杯咖啡，LinkShell 默默守护当前状态。</p>
        </div>
        
        <!-- Card 2 -->
        <div class="bg-brand text-white border border-transparent rounded-[2rem] p-10 shadow-[0_0_40px_-10px_rgba(0,0,0,0.5)] hover:shadow-brand/20 transition-all duration-500 hover:-translate-y-2 md:translate-y-6 relative overflow-hidden group">
          <!-- 内部点束光 -->
          <div class="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent"></div>
          <div class="absolute -right-10 -top-10 w-40 h-40 bg-white/10 blur-3xl rounded-full group-hover:scale-150 transition-transform duration-700"></div>
          
          <div class="relative z-10 w-16 h-16 rounded-2xl bg-white/10 border border-white/20 flex items-center justify-center mb-8 text-3xl shadow-inner group-hover:scale-110 transition-transform duration-500">
            ☕
          </div>
          <h3 class="text-2xl font-bold mb-4 relative z-10" data-i18n="l2Title">随时审查</h3>
          <p class="text-gray-300 leading-relaxed relative z-10" data-i18n="l2Desc">随时掏出手机接入会话。审查构建进度，翻看彩色日志输出，体验不到任何画面的延迟衰减。</p>
        </div>
        
        <!-- Card 3 -->
        <div class="bg-surface border border-border rounded-[2rem] p-10 hover:shadow-2xl hover:shadow-brand/5 transition-all duration-500 hover:-translate-y-2">
          <div class="w-16 h-16 rounded-2xl bg-brand/5 border border-border flex items-center justify-center mb-8 text-3xl group-hover:scale-110 transition-transform duration-500">
            🚶
          </div>
          <h3 class="text-2xl font-bold mb-4" data-i18n="l3Title">直接修正</h3>
          <p class="text-muted leading-relaxed" data-i18n="l3Desc">发现报错？内置 xterm.js 拿过焦点，敲下修复命令，然后再次从容地把手机放回口袋。</p>
        </div>
      </div>
    </section>

    """
    
    new_content = content[:start_idx] + new_section + content[end_idx:]
    with open("docs/site/index.html", "w", encoding="utf-8") as f:
        f.write(new_content)
    print("Replaced section.")
else:
    print("Tags not found.")
