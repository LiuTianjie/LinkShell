import { SCREEN_LOADING_HTML, SCREEN_LOADING_STYLE } from "../screen-loading.js";
import { ICONS } from "./constants.js";
import { VIEWER_STYLE } from "./css.js";

/** Renders the standalone screen-viewer HTML document with inline styles and assembled viewer script. */
export function renderViewerHtml(
  platform: NodeJS.Platform,
  locale: "zh" | "en" | "ja",
  script: string,
): string {
  const dataPlatform = platform === "win32" ? "win32" : platform === "linux" ? "linux" : "darwin";
  const altGlyph = platform === "darwin" ? "⌥" : "Alt";
  const altLabel = platform === "darwin" ? "option" : "alt";
  const cmdGlyph = platform === "win32" ? "Win" : platform === "linux" ? "Super" : "⌘";
  const cmdLabel = platform === "win32" ? "windows" : platform === "linux" ? "super" : "command";
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>屏幕</title>
<style>${VIEWER_STYLE}${SCREEN_LOADING_STYLE}</style></head>
<body data-platform="${dataPlatform}"${locale !== "zh" ? ` data-lang="${locale}"` : ""}>
<div id="stage"><div id="picture"><canvas id="screen"></canvas><canvas id="gpu" class="gone"></canvas><video id="video" class="gone" autoplay playsinline muted></video><div id="pointer"></div></div></div>
${SCREEN_LOADING_HTML}
<div id="toast" class="glass"></div>
<div id="menu" class="glass gone">
  <div class="choice" role="button" aria-label="只看，不操作电脑" data-mode="view"><i></i><div><b>只看</b><span>不操作电脑</span></div></div>
  <div class="choice" role="button" aria-label="触控板，滑动指针，轻点点击" data-mode="trackpad"><i></i><div><b>触控板</b><span>滑动指针 · 轻点点击</span></div></div>
  <div class="choice" role="button" aria-label="点按，点按画面直接操作" data-mode="touch"><i></i><div><b>点按</b><span>点按画面直接操作</span></div></div>
</div>
<div id="connection" class="glass gone">
  <div id="connectionhead"><span id="connheadtext">连接信息</span><div class="tool" id="closeinfo" role="button" aria-label="关闭连接信息">${ICONS.close}</div></div>
  <div id="status"></div>
  <div id="widths" class="gone">
    <div class="group"><span id="widthshead">清晰度（直连视频）</span></div>
    <div class="tiles">
      <div class="tile" role="button" aria-label="流畅，1280 宽" data-width="1280"><b>流畅</b><span>1280</span></div>
      <div class="tile" role="button" aria-label="标准，1920 宽" data-width="1920"><b>标准</b><span>1920</span></div>
      <div class="tile" role="button" aria-label="高清，2560 宽" data-width="2560"><b>高清</b><span>2560</span></div>
      <div class="tile" role="button" aria-label="原生，屏幕本身的分辨率" data-width="native"><b>原生</b><span>最高 4K</span></div>
    </div>
  </div>
  <div id="pacing" class="gone">
    <div class="group"><span id="pacinghead">画面节奏</span></div>
    <div class="tiles">
      <div class="tile" role="button" aria-label="延迟优先，最跟手，网络抖动时会短暂停顿" data-pacing="immediate"><b>延迟优先</b><span>最跟手</span></div>
      <div class="tile" role="button" aria-label="流畅优先，画面更均匀，Wi-Fi 下延迟约多 50 毫秒，适合只观看" data-pacing="smooth"><b>流畅优先</b><span>适合观看</span></div>
    </div>
  </div>
  <div id="clipboard">
    <div class="group"><span id="cliphead">加密剪贴板</span></div>
    <div class="tiles two">
      <div class="tile" id="pastecomputer" role="button" aria-label="粘贴到电脑"><b>粘贴到电脑</b><span>发送剪贴板</span></div>
      <div class="tile" id="copycomputer" role="button" aria-label="读取电脑剪贴板"><b>读取电脑剪贴板</b><span>复制到本机</span></div>
    </div>
  </div>
  <div id="privacy">
    <div class="group"><span id="privacyhead">隐私保护</span></div>
    <div class="tiles two">
      <div class="tile" id="privacycurtain" role="button" aria-label="防窥黑屏" aria-pressed="false"><b>防窥黑屏</b><span>遮挡远端屏幕</span></div>
      <div class="tile" id="lockdisconnect" role="button" aria-label="断开时自动锁屏" aria-pressed="false"><b>断开时自动锁屏</b><span>离开自动锁定</span></div>
    </div>
  </div>
  <div id="langs">
    <div class="group"><span id="langhead">界面语言</span></div>
    <div class="tiles three">
      <div class="tile" role="button" aria-label="简体中文" data-lang="zh"><b>中文</b><span>简体</span></div>
      <div class="tile" role="button" aria-label="English" data-lang="en"><b>English</b><span>EN</span></div>
      <div class="tile" role="button" aria-label="日本語" data-lang="ja"><b>日本語</b><span>JA</span></div>
    </div>
  </div>
</div>
<div id="control-shell" class="glass" aria-hidden="true"></div>
<div id="bar">
  <div class="tool" id="mode" role="button" aria-label="控制方式"></div>
  <div class="tool" id="keyboard" role="button" aria-label="键盘">${ICONS.keyboard}</div>
  <div class="tool" id="quick" role="button" aria-label="快捷操作">${ICONS.quick}</div>
  <div class="tool" id="clipbar" role="button" aria-label="剪贴板与隐私"></div>
  <div class="tool" id="audiobar" role="button" aria-label="声音" aria-pressed="false">${ICONS.soundOff}</div>
  <div class="tool" id="fit" role="button" aria-label="还原缩放">${ICONS.fit}</div>
  <div class="tool" id="info" role="button" aria-label="连接信息">${ICONS.info}</div>
  <div class="tool" id="full" role="button" aria-label="全屏"></div>
</div>
<div id="orb" role="button" aria-label="展开屏幕控制"><div class="orb-core"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></div></div>
<div id="sheet" class="glass gone">
  <div id="sheethead">
    <div id="compose" role="button">发送文字…</div>
    <div class="tool" id="sheetkeys" role="button" aria-label="键盘"></div>
    <div class="tool" id="sheetclose" role="button" aria-label="关闭"></div>
  </div>
  <div id="actions"></div>
  <div id="maker" class="gone">
    <div class="group"><span>添加快捷键</span><span id="makersign"></span></div>
    <div class="tiles" id="makermods">
      <div class="tile" data-mod="ctrl"><b>⌃</b><span>control</span></div>
      <div class="tile" data-mod="alt"><b>${altGlyph}</b><span>${altLabel}</span></div>
      <div class="tile" data-mod="shift"><b>⇧</b><span>shift</span></div>
      <div class="tile" data-mod="cmd"><b>${cmdGlyph}</b><span>${cmdLabel}</span></div>
    </div>
    <label class="field"><span>按键</span><select id="makerkey" aria-label="按键"></select></label>
    <label class="field"><span>名称</span><input id="makername" type="text" maxlength="16" placeholder="可不填" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done" aria-label="名称"></label>
    <div class="ends"><div class="soft" id="makercancel" role="button">取消</div><div class="soft strong" id="makersave" role="button">添加</div></div>
  </div>
</div>
<div id="composer" class="gone">
  <div id="wordsbox"><textarea id="words" maxlength="20000" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="要发送的文字"></textarea><div id="wordshint">在这里写好，再发到电脑上</div></div>
  <div id="sendrow">
    <div class="soft" id="composeclose" role="button" aria-label="收起"></div>
    <div class="soft" id="pasteclip" role="button">粘贴手机剪贴板</div>
    <div class="spring"></div>
    <div class="soft" id="sendreturn" role="button">发送并回车</div>
    <div class="soft strong" id="sendwords" role="button">发送</div>
  </div>
</div>
<div id="keys" class="gone">
  <div class="key" id="quickkey" role="button" aria-label="快捷操作"></div>
  <div class="key" id="composekey" role="button" aria-label="发送文字"></div>
  <div class="key word" data-key="escape">esc</div>
  <div class="key word" data-key="tab">tab</div>
  <div class="key" data-mod="ctrl">⌃</div>
  <div class="key" data-mod="alt">${altGlyph}</div>
  <div class="key" data-mod="cmd">${cmdGlyph}</div>
  <div class="key" data-mod="shift">⇧</div>
  <div class="key" data-key="left">←</div>
  <div class="key" data-key="down">↓</div>
  <div class="key" data-key="up">↑</div>
  <div class="key" data-key="right">→</div>
  <div class="key" id="hide" role="button" aria-label="收起键盘"></div>
</div>
<textarea id="typing" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="enter" aria-label="键盘输入"></textarea>
<input id="shortcut" type="email" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="快捷键">
<script type="application/json" id="icons">${JSON.stringify(ICONS)}</script>
<script>${script}</script>
</body></html>`;
}
