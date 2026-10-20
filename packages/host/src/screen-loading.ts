// Shared by the browser viewer and the phone's WebView, including native video reception.
export const SCREEN_LOADING_STYLE = String.raw`
  #note { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    padding: max(28px, env(safe-area-inset-top)) 24px max(88px, env(safe-area-inset-bottom));
    color: #f4f4f7; text-align: center; pointer-events: none; background: rgba(8,9,14,.94); }
  .screen-loading-card { width: min(100%, 340px); }
  .screen-loading-art { position: relative; width: 104px; height: 84px; margin: 0 auto 28px; color: #a5a9ef; }
  .screen-loading-art::before { content: ''; position: absolute; inset: -32px; border-radius: 50%;
    background: radial-gradient(ellipse, rgba(129,140,248,.16), transparent 68%); animation: screen-breathe 2.8s ease-in-out infinite; }
  .screen-loading-monitor { position: absolute; inset: 6px 4px 17px; border: 1px solid rgba(165,169,239,.5); border-radius: 10px;
    background: rgba(129,140,248,.05); overflow: hidden; }
  .screen-loading-monitor::before { content: ''; position: absolute; top: 12px; left: 12px; width: 23px; height: 4px;
    border-radius: 2px; background: rgba(165,169,239,.4); box-shadow: 0 11px 0 rgba(165,169,239,.12), 0 22px 0 rgba(165,169,239,.12); }
  .screen-loading-monitor::after { content: ''; position: absolute; top: 0; bottom: 0; left: -45%; width: 45%;
    background: linear-gradient(90deg, transparent, rgba(165,169,239,.16), transparent); animation: screen-scan 2.4s ease-in-out infinite; }
  .screen-loading-stand { position: absolute; bottom: 8px; left: 50%; width: 26px; height: 10px; transform: translateX(-50%);
    border-bottom: 1px solid rgba(165,169,239,.5); }
  .screen-loading-stand::before { content: ''; position: absolute; left: 50%; height: 9px; border-left: 1px solid rgba(165,169,239,.5); }
  #screen-loading-title { margin: 0; font-size: calc(18px * var(--text-scale, 1)); font-weight: 600; letter-spacing: -.3px; }
  #screen-loading-detail { margin: 10px 0 0; color: rgba(255,255,255,.52); font-size: calc(13px * var(--text-scale, 1)); line-height: 1.7; overflow-wrap: anywhere; }
  .screen-loading-steps { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 24px;
    color: rgba(255,255,255,.3); font-size: calc(11px * var(--text-scale, 1)); }
  .screen-loading-steps i { width: 24px; height: 1px; background: rgba(255,255,255,.12); }
  .screen-loading-steps .current { color: #bbbffb; }
  .screen-loading-steps .complete { color: rgba(255,255,255,.68); }
  #note[data-state="error"] .screen-loading-steps { display: none; }
  #screen-loading-retry { pointer-events: auto; margin-top: 22px; min-height: 44px; padding: 0 20px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.07); color: #eeeef4; font: inherit; font-size: 13px; cursor: pointer; }
  #screen-loading-retry:hover { background: rgba(255,255,255,.13); }
  #screen-loading-retry:focus-visible { outline: 2px solid #a5a9ef; outline-offset: 4px; }
  #note[data-state="error"] .screen-loading-art::before, #note[data-state="error"] .screen-loading-monitor::after,
  #note[data-state="blocked"] .screen-loading-art::before, #note[data-state="blocked"] .screen-loading-monitor::after,
  #note[data-state="paused"] .screen-loading-art::before, #note[data-state="paused"] .screen-loading-monitor::after { animation: none; opacity: .3; }
  @keyframes screen-scan { to { transform: translateX(340%); } }
  @keyframes screen-breathe { 50% { opacity: .4; transform: scale(.92); } }
  @media (prefers-reduced-motion: reduce) { .screen-loading-art::before, .screen-loading-monitor::after { animation: none; } }
  @media (max-height: 420px) { #note { padding: 16px 72px; } .screen-loading-art { height: 64px; margin-bottom: 12px; }
    .screen-loading-steps { margin-top: 14px; } #screen-loading-retry { margin-top: 12px; } }
`;

export const SCREEN_LOADING_HTML = String.raw`
<div id="note" data-state="connecting">
  <div class="screen-loading-card">
    <div class="screen-loading-art" aria-hidden="true"><div class="screen-loading-monitor"></div><div class="screen-loading-stand"></div></div>
    <div role="status" aria-live="polite" aria-atomic="true">
      <h2 id="screen-loading-title">正在连接电脑</h2>
      <p id="screen-loading-detail">正在建立屏幕连接，画面会自动显示。</p>
    </div>
    <div class="screen-loading-steps" aria-hidden="true"><span id="screen-step-connect" class="current">连接电脑</span><i></i><span id="screen-step-picture">接收画面</span><i></i><span>显示桌面</span></div>
    <button id="screen-loading-retry" class="gone" type="button">重新连接</button>
  </div>
</div>`;

export const SCREEN_LOADING_SCRIPT = String.raw`
function createScreenLoading(root, retry, report) {
  const title = root.querySelector('#screen-loading-title');
  const detail = root.querySelector('#screen-loading-detail');
  const button = root.querySelector('#screen-loading-retry');
  const connectStep = root.querySelector('#screen-step-connect');
  const pictureStep = root.querySelector('#screen-step-picture');
  let phase = '', timer = 0, slow = false, disposed = false;
  const pending = () => phase === 'connecting' || phase === 'receiving' || phase === 'recovering' || phase === 'adjusting';
  const description = () => slow ? '这次连接耗时较长。可以继续等待，或重新连接。' :
    phase === 'receiving' ? '电脑已响应，画面准备好后会自动显示。' :
    phase === 'adjusting' ? '正在应用屏幕设置，请稍候。' :
    phase === 'recovering' ? '正在尝试恢复画面，请稍候。' : '正在建立屏幕连接，画面会自动显示。';
  function set(next, message) {
    if (disposed || (phase === next && !message)) return;
    const wasPending = pending();
    phase = next;
    root.dataset.state = phase;
    root.classList.toggle('gone', phase === 'ready');
    if (!pending()) { clearTimeout(timer); timer = 0; slow = false; }
    else if (!wasPending) {
      timer = setTimeout(() => {
        if (!pending() || disposed) return;
        slow = true;
        detail.textContent = description();
        button.classList.remove('gone');
      }, 12000);
    }
    title.textContent = phase === 'connecting' ? '正在连接电脑' : phase === 'receiving' ? '正在接收画面' :
      phase === 'recovering' ? '正在恢复画面' : phase === 'adjusting' ? '正在调整屏幕' : phase === 'paused' ? '屏幕已暂停' : phase === 'blocked' ? '画面已就绪，轻点开始' : phase === 'error' ? '暂时无法显示屏幕' : '画面已连接';
    detail.textContent = message || (pending() ? description() : phase === 'paused' ? '返回屏幕后会自动继续。' : '');
    button.classList.toggle('gone', phase !== 'error' && !slow);
    connectStep.className = phase === 'connecting' ? 'current' : 'complete';
    pictureStep.className = phase === 'receiving' || phase === 'recovering' ? 'current' : '';
    report(phase);
  }
  button.addEventListener('click', (event) => { event.stopPropagation(); retry(); });
  set('connecting');
  return { set, get phase() { return phase; }, dispose() { disposed = true; clearTimeout(timer); } };
}
`;
