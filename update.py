import re

with open("docs/site/index.html", "r", encoding="utf-8") as f:
    content = f.read()

# Make the quickstart more detailed, looking like actual bash sequences with copy buttons (simulated visually)
new_quickstart = """
    <!-- Quickstart -->
    <section class="max-w-5xl mx-auto px-6 mb-24" id="quickstart">
      <h2 class="text-3xl md:text-4xl font-bold tracking-tight mb-16 text-center" data-i18n="howItWorksTitle">只需三步，连接你的终端</h2>
      
      <div class="grid grid-cols-1 xl:grid-cols-3 gap-8">
        <!-- Step 1 -->
        <div class="bento-card relative">
          <div class="absolute -top-5 left-6 w-10 h-10 rounded-xl bg-brand text-white flex items-center justify-center font-bold text-lg shadow-lg">1</div>
          <h3 class="font-bold text-lg mb-3 mt-2" data-i18n="step1Title">部署 Gateway</h3>
          <p class="text-sm text-muted mb-4" data-i18n="step1Desc">在一台公网机器上启动网关服务，负责信令与数据包的中转，不碰你的终端内容。</p>
          <div class="bg-brand text-white font-mono text-xs p-4 rounded-xl space-y-2 overflow-x-auto shadow-inner">
            <div class="text-gray-400"># 拉取仓库并启动路由中转</div>
            <div class="text-green-400">$ <span class="text-white">git clone https://github.com/user/linkshell.git</span></div>
            <div class="text-green-400">$ <span class="text-white">cd linkshell && pnpm start:gateway</span></div>
            <div class="text-gray-400 mt-2"># 或者使用 Docker</div>
            <div class="text-green-400">$ <span class="text-white">docker compose up -d</span></div>
          </div>
        </div>

        <!-- Step 2 -->
        <div class="bento-card relative">
          <div class="absolute -top-5 left-6 w-10 h-10 rounded-xl bg-brand text-white flex items-center justify-center font-bold text-lg shadow-lg">2</div>
          <h3 class="font-bold text-lg mb-3 mt-2" data-i18n="step2Title">启动本地桥接</h3>
          <p class="text-sm text-muted mb-4" data-i18n="step2Desc">回到你的工作电脑，使用 CLI 将当前终端进程桥接到刚才部署的 Gateway 上。</p>
          <div class="bg-brand text-white font-mono text-xs p-4 rounded-xl space-y-2 overflow-x-auto shadow-inner">
            <div class="text-gray-400"># 全局安装终端桥接 CLI</div>
            <div class="text-green-400">$ <span class="text-white">npm install -g @linkshell/cli</span></div>
            <div class="text-gray-400 mt-2"># 桥接到 Gateway</div>
            <div class="text-green-400">$ <span class="text-white">linkshell start --gateway wss://&lt;IP&gt;/ws</span></div>
            <div class="text-emerald-300 mt-3 font-semibold">➜ 获得配对码: 847293</div>
          </div>
        </div>

        <!-- Step 3 -->
        <div class="bento-card relative border-2 border-brand shadow-xl">
          <div class="absolute -top-5 left-6 w-10 h-10 rounded-xl border-2 border-brand bg-white text-brand flex items-center justify-center font-bold text-lg shadow-lg">3</div>
          <h3 class="font-bold text-lg mb-3 mt-2 text-brand" data-i18n="step3Title">手机端接管</h3>
          <p class="text-sm text-muted mb-4" data-i18n="step3Desc">用你的手机浏览器打开调试端页面，输入刚生成的 6 位配对码，立刻接管本地会话。</p>
          <div class="bg-surface border-2 border-border font-mono text-sm p-4 rounded-xl flex flex-col items-center justify-center min-h-[148px]">
            <div class="text-gray-500 mb-3 text-xs uppercase tracking-widest font-bold">填入匹配码连接 PTY</div>
            <div class="flex gap-2 text-2xl font-bold tracking-widest text-brand bg-white px-4 py-2 rounded-lg border border-border shadow-sm">
              <span class="border-b-2 border-brand px-1">8</span>
              <span class="border-b-2 border-brand px-1">4</span>
              <span class="border-b-2 border-brand px-1">7</span>
              <span class="text-gray-300 px-1">-</span>
              <span class="border-b-2 border-brand px-1">2</span>
              <span class="border-b-2 border-brand px-1">9</span>
              <span class="border-b-2 border-brand px-1">3</span>
            </div>
          </div>
        </div>
      </div>
    </section>
"""

content = re.sub(
    r'<!-- Quickstart -->\s*<section class="max-w-5xl mx-auto px-6 mb-24" id="quickstart">.*?</section>',
    new_quickstart.strip(),
    content,
    flags=re.DOTALL
)

new_script = """  <script>
    const translations = {
      zh: {
        pageTitle: "LinkShell | 始于桌面，随处接管",
        navDocs: "工作原理",
        navGithub: "GitHub",
        heroBadge: "LinkShell v1.0 直连就绪",
        heroTitle1: "终端漫游",
        heroTitle2: "随时随地，接管本地",
        heroLead: "纯粹的终端桥接（Terminal Bridge）方案。长耗时任务留在高性能桌面上，用手机随时接管远端 PTY 会话。",
        btnStart: "立即部署",
        btnGithub: "查看仓库",
        featureSectionTitle: "原生的终端体感，去中心化的控制。",
        f1Title: "本地 PTY 驱动",
        f1Desc: "繁重的计算过程完全依赖本地机器。保留颜色、光标、 readline 输出及信号等完整终端语义。",
        f2Title: "全平台客户端",
        f2Desc: "支持 React Native / Expo 移动端与 Web 页面调试端。纯粹的单一协议，跨平台劫持终端流。",
        f3Title: "强一致性同步",
        f3Desc: "独有的单控制者防冲突模型（Single Controller）。避免多端并抢焦点，画面精准对齐不串流。",
        lifestyleSectionTitle: "LinkShell 工作流",
        lifestyleLead: "不仅是远程命令行桥接；更是打破工位束缚的极客探索。",
        l1Title: "挂起并离开",
        l1Desc: "编译、构建、拉镜像... 常驻任务在桌面上飞速运转。你可以去喝杯咖啡，LinkShell 默默守护当前状态。",
        l2Title: "随时审查",
        l2Desc: "随时掏出手机接入会话。审查构建进度，翻看彩色日志输出，体验不到任何画面的延迟衰减。",
        l3Title: "直接修正",
        l3Desc: "发现报错？内置 xterm.js 拿过焦点，敲下修复命令，然后再次从容地把手机放回口袋。",
        powerSectionTitle: "不妥协的工程体验",
        p1Title: "全功能屏幕视图",
        p1Desc: "使用 xterm.js 构建画面。哪怕只看手机屏幕，Vim、HTop、交互环境等富终端应用依然拥有极致呈现。",
        p2Title: "ACK 断线续联",
        p2Desc: "自研 WebSocket 缓冲与 ACK 序列指令机制。进电梯断网？重连后从缓存栈补齐每一行丢失的日志。",
        p3Title: "严苛输入保护",
        p3Desc: "多重锁定唯一 Owner。谁在看终端，谁就是唯一写入者。Desktop 和 App 端壁垒分明，不再误导指令流。",
        howItWorksTitle: "只需三步，建立你的终端链路",
        step1Title: "部署 Gateway",
        step1Desc: "在一台公网机器上启动网关服务，负责信令与数据包的中转，不碰你的终端内容。",
        step2Title: "启动本地桥接",
        step2Desc: "回到你的工作电脑，使用 CLI 将当前终端进程桥接到刚才部署的 Gateway 上。",
        step3Title: "手机端接管",
        step3Desc: "用你的手机浏览器打开调试端页面，输入刚生成的 6 位配对码，立刻接管本地会话。",
        ctaTitle: "准备好你的第一次漫游了吗？",
        ctaDesc: "放弃冗长的云端迁移。仅需几十秒进行网关转接，把完整的本地开发环境装进口袋。",
        footerText: "出于对 Vibe Coding 的热爱。© 2026 基于 MIT 协议开源。探索自由编程边界。"
      },
      en: {
        pageTitle: "LinkShell | Desktop First, Roam Anywhere",
        navDocs: "How It Works",
        navGithub: "GitHub",
        heroBadge: "LinkShell v1.0 is Live",
        heroTitle1: "Terminal Bridge",
        heroTitle2: "Take over anywhere.",
        heroLead: "A pure Terminal Bridge architecture. Keep heavy workloads on your desktop, and claim the PTY session from your phone anywhere.",
        btnStart: "Deploy Now",
        btnGithub: "View Repo",
        featureSectionTitle: "Native terminal feel. Decentralized control.",
        f1Title: "Local PTY Driver",
        f1Desc: "Everything runs locally. We preserve full terminal semantics: ANSI colors, cursor movements, and raw readline signals.",
        f2Title: "Universal Connect",
        f2Desc: "Supports React Native, Expo, and Web clients natively via a unified protocol. Instantly hijack the I/O stream.",
        f3Title: "Strict State Sync",
        f3Desc: "Features a Single Controller locking model. Prevent multi-device input races and keep screens meticulously synchronized.",
        lifestyleSectionTitle: "The LinkShell Workflow",
        lifestyleLead: "It's not just a remote bridge. It's your declaration of independence from the desk.",
        l1Title: "Suspend & Walk",
        l1Desc: "Compiling, training, building... your desktop handles it. Step away for coffee; LinkShell keeps your PTY session perfectly alive.",
        l2Title: "Review Anytime",
        l2Desc: "Pull out your phone and jump back in. Check build limits and scroll through colorful logs with zero cloud decay.",
        l3Title: "Quick Hotfix",
        l3Desc: "Spot an error? The mobile xterm.js instance takes focus. Type the fix, hit enter, and drop your phone back in your pocket.",
        powerSectionTitle: "Uncompromising Engineering",
        p1Title: "Full Render View",
        p1Desc: "Built on top of xterm.js. Experience uncompromised fidelity for Vim, HTop, and interactive TUI apps on any screen.",
        p2Title: "ACK Reconnection",
        p2Desc: "Custom WebSocket buffers with an ACK replay mechanism. Network dropped in an elevator? Resync every single log line instantly.",
        p3Title: "Isolated Control",
        p3Desc: "Strict Owner locking. Whoever views the session commands the buffer. Desktop and Mobile environments never clash on keystrokes.",
        howItWorksTitle: "Establish your link in 3 steps",
        step1Title: "Deploy Gateway",
        step1Desc: "Host the relay server on a public IP to route websocket payloads without touching their contents.",
        step2Title: "Bridge Local PTY",
        step2Desc: "Hop back to your dev machine. Use the CLI to bridge the active terminal session to your Gateway.",
        step3Title: "Claim on Phone",
        step3Desc: "Open the mobile app or web client, punch in the 6-digit code, and fully take over your local session.",
        ctaTitle: "Ready for your first roam?",
        ctaDesc: "Skip the heavy cloud VM migrations. Set up the relay in seconds and put your whole dev environment in your pocket.",
        footerText: "Crafted for Vibe Coding. © 2026 Open Source / MIT. Pushing the boundaries of freedom."
      }
    };"""

content = re.sub(
    r'<script>\s*const translations = \{.*?};',
    new_script,
    content,
    flags=re.DOTALL
)

with open("docs/site/index.html", "w", encoding="utf-8") as f:
    f.write(content)

