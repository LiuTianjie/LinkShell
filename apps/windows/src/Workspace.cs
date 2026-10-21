using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;

namespace LinkShell.Windows {
    internal sealed class WorkspacePolicy {
        readonly Uri origin;
        public WorkspacePolicy(Uri value) { origin = value; }
        public static Uri Ready(string json) {
            Uri value;
            if (!Uri.TryCreate(Desktop.Text(Desktop.Json.DeserializeObject(json), "url"), UriKind.Absolute, out value)
                || value.Scheme != "http" || value.Host != "127.0.0.1" || value.Port < 1 || value.UserInfo.Length != 0
                || value.AbsolutePath != "/" || value.Query.Length != 0 || !Regex.IsMatch(value.Fragment, "^#desktop=[A-Za-z0-9_-]{32,256}$"))
                throw new InvalidOperationException("工作台返回了无效的本地地址，请重新安装 LinkShell。");
            return value;
        }
        public bool Trusted(string source) {
            Uri value;
            return Uri.TryCreate(source, UriKind.Absolute, out value) && value.Scheme == origin.Scheme && value.Host == origin.Host && value.Port == origin.Port && value.UserInfo.Length == 0;
        }
        public bool Download(string source) { return Trusted(source.StartsWith("blob:", StringComparison.Ordinal) ? source.Substring(5) : source); }
        public static bool External(string source) {
            Uri value;
            if (!Uri.TryCreate(source, UriKind.Absolute, out value) || (value.Scheme != "https" && value.Scheme != "http") || value.UserInfo.Length != 0) return false;
            string host = value.DnsSafeHost.ToLowerInvariant();
            return host.Length > 0 && !value.IsLoopback && host != "0.0.0.0" && !host.EndsWith(".localhost", StringComparison.Ordinal) && !host.StartsWith("127.", StringComparison.Ordinal) && !host.StartsWith("169.254.", StringComparison.Ordinal);
        }
    }

    // A standard HWND WebView keeps WebRTC in Chromium's GPU pipeline (no WPF frame copies).
    internal sealed class Workspace : Grid, IDisposable {
        WebView2 browser;
        Process sidecar;
        WorkspacePolicy policy;
        bool disposed, starting, ready, visible;
        string appearance = "dark";
        string flushId;
        TaskCompletionSource<bool> flush;
        readonly Action manage;
        readonly Action<string> changeAppearance;
        readonly StackPanel status = new StackPanel { MaxWidth = 500, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        public Workspace(Action management, Action<string> theme) {
            manage = management; changeAppearance = theme;
            SetResourceReference(BackgroundProperty, "Background");
            Children.Add(status);
            ShowStatus("正在准备工作台…", false);
        }
        public CoreWebView2 Core { get { return browser == null ? null : browser.CoreWebView2; } }
        public bool Ready { get { return ready; } }
        void ShowStatus(string message, bool retry) {
            if (browser != null) browser.Visibility = Visibility.Hidden;
            status.Visibility = Visibility.Visible; status.Children.Clear();
            var heading = new TextBlock { Text = "LinkShell 工作台", FontSize = 24, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 14) };
            heading.SetResourceReference(TextBlock.ForegroundProperty, "Primary"); status.Children.Add(heading);
            var detail = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 18) };
            detail.SetResourceReference(TextBlock.ForegroundProperty, "Secondary"); status.Children.Add(detail);
            if (retry) {
                var reconnect = new Button { Content = "重新连接", Margin = new Thickness(0, 0, 0, 10) };
                reconnect.Click += async (s, e) => { if (await CanDiscard("重新连接")) { await Stop(); await Start(); } }; status.Children.Add(reconnect);
                var runtime = new Button { Content = "安装 / 修复 WebView2 Runtime", Margin = new Thickness(0, 0, 0, 10) };
                runtime.Click += (s, e) => LaunchExternal("https://go.microsoft.com/fwlink/p/?LinkId=2124703"); status.Children.Add(runtime);
            }
            var management = new Button { Content = "本机管理" }; management.Click += (s, e) => manage(); status.Children.Add(management);
        }
        public async Task Start() {
            if (disposed || starting || browser != null) return;
            starting = true; ShowStatus("正在连接本机服务…", false);
            Exception failure = null;
            try {
                string assets = Environment.GetEnvironmentVariable("LINKSHELL_DESKTOP_WEB") ?? Path.Combine(Desktop.Root, "workspace");
                sidecar = Desktop.Command("desktop-workspace", "--assets", assets);
                var child = sidecar;
                child.ErrorDataReceived += (s, e) => { /* The sidecar owns diagnostics; never copy account or draft data into UI logs. */ };
                child.BeginErrorReadLine();
                var line = child.StandardOutput.ReadLineAsync();
                if (await Task.WhenAny(line, Task.Delay(20000)) != line) throw new TimeoutException("工作台启动超时，请重试。");
                string message = await line;
                if (disposed) return;
                if (message == null) throw new InvalidOperationException("工作台服务未能启动，请重新安装或重试。");
                var url = WorkspacePolicy.Ready(message); policy = new WorkspacePolicy(url);
                child.EnableRaisingEvents = true;
                child.Exited += (s, e) => Dispatcher.BeginInvoke(new Action(() => {
                    if (!disposed && sidecar == child) ShowStatus("工作台连接已断开。重新连接前会先尝试保存草稿。", true);
                }));
                browser = new WebView2 { CreationProperties = new CoreWebView2CreationProperties {
                    UserDataFolder = Path.Combine(Desktop.Home, "webview2"), IsInPrivateModeEnabled = true
                } };
                Children.Insert(0, browser);
                await browser.EnsureCoreWebView2Async();
                if (disposed) return;
                Core.Settings.AreDevToolsEnabled = false;
                Core.Settings.AreDefaultContextMenusEnabled = false;
                Core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                Core.Settings.IsStatusBarEnabled = false;
                Core.Settings.IsGeneralAutofillEnabled = false;
                Core.Settings.IsPasswordAutosaveEnabled = false;
                Core.Settings.IsZoomControlEnabled = false;
                Core.Settings.AreHostObjectsAllowed = false;
                Core.NavigationStarting += (s, e) => { if (!policy.Trusted(e.Uri)) { e.Cancel = true; if (e.IsUserInitiated) LaunchExternal(e.Uri); } };
                Core.NewWindowRequested += (s, e) => { e.Handled = true; if (e.IsUserInitiated) LaunchExternal(e.Uri); };
                Core.PermissionRequested += (s, e) => {
                    e.State = e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead && e.IsUserInitiated && policy.Trusted(e.Uri)
                        ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
                    e.Handled = true;
                };
                // CoreWebView2.WebMessageReceived receives only the top-level document. Never subscribe to frame bridges.
                Core.WebMessageReceived += Receive;
                Core.DownloadStarting += Download;
                Core.ProcessFailed += (s, e) => { ready = false; ShowStatus("工作台页面进程已退出，请重新连接。", true); };
                Core.NavigationCompleted += async (s, e) => {
                    if (disposed) return;
                    ready = e.IsSuccess && policy.Trusted(Core.Source);
                    if (!ready) { ShowStatus("工作台页面加载失败，请重新连接。", true); return; }
                    status.Visibility = Visibility.Collapsed; browser.Visibility = Visibility.Visible;
                    await UpdateState();
                };
                await Core.AddScriptToExecuteOnDocumentCreatedAsync("if(window===window.top){window.__LINKSHELL_DESKTOP_VISIBLE__=" + (visible ? "true" : "false") + ";window.__LINKSHELL_DESKTOP_APPEARANCE__=" + Desktop.Json.Serialize(appearance) + ";}");
                Core.Navigate(url.AbsoluteUri);
            } catch (Exception error) {
                failure = error;
            } finally { starting = false; }
            if (failure != null) {
                await Stop();
                if (!disposed) ShowStatus(failure is WebView2RuntimeNotFoundException ? "需要 Microsoft Edge WebView2 Runtime。安装后点击重新连接，无需重启电脑。" : "无法打开工作台：" + failure.Message, true);
            }
        }
        void Receive(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
            if (policy == null || !policy.Trusted(e.Source) || Core == null || !policy.Trusted(Core.Source)) return;
            try {
                if (e.WebMessageAsJson.Length > 8192) return;
                var data = Desktop.Json.DeserializeObject(e.WebMessageAsJson);
                switch (Desktop.Text(data, "action")) {
                    case "manage": manage(); break;
                    case "external": LaunchExternal(Desktop.Text(data, "url")); break;
                    case "appearance":
                        string value = Desktop.Text(data, "value");
                        if (value == "light" || value == "dark" || value == "system") changeAppearance(value);
                        break;
                    case "flushed":
                        if (flush != null && Desktop.Text(data, "id") == flushId) flush.TrySetResult(Object.Equals(Desktop.Get(data, "saved"), true));
                        break;
                }
            } catch (Exception) { /* Ignore malformed bridge messages from page content. */ }
        }
        static void LaunchExternal(string value) { if (WorkspacePolicy.External(value)) Process.Start(new ProcessStartInfo(value) { UseShellExecute = true }); }
        void Download(object sender, CoreWebView2DownloadStartingEventArgs e) {
            e.Handled = true; e.Cancel = true;
            if (!policy.Download(e.DownloadOperation.Uri)) return;
            // Native modal loops must start after the WebView2 event returns.
            var deferral = e.GetDeferral();
            Dispatcher.BeginInvoke(new Action(() => {
                try {
                    if (disposed) return;
                    var dialog = new SaveFileDialog { FileName = Path.GetFileName(e.ResultFilePath), OverwritePrompt = true, Title = "保存文件" };
                    if (dialog.ShowDialog(Window.GetWindow(this)) == true) { e.ResultFilePath = dialog.FileName; e.Cancel = false; }
                } finally { deferral.Complete(); }
            }));
        }
        public async Task SetState(bool shown, string theme) { visible = shown; appearance = theme; await UpdateState(); }
        async Task UpdateState() {
            if (!ready || Core == null || !policy.Trusted(Core.Source)) return;
            try {
                await Core.ExecuteScriptAsync("window.__LINKSHELL_DESKTOP_VISIBLE__=" + (visible ? "true" : "false") + ";window.dispatchEvent(new CustomEvent('linkshell-desktop-visibility',{detail:{visible:window.__LINKSHELL_DESKTOP_VISIBLE__}}));window.__LINKSHELL_DESKTOP_APPEARANCE__=" + Desktop.Json.Serialize(appearance) + ";window.dispatchEvent(new CustomEvent('linkshell-desktop-appearance',{detail:{appearance:window.__LINKSHELL_DESKTOP_APPEARANCE__}}));");
            } catch (InvalidOperationException) { }
        }
        public async Task<bool> Flush() {
            if (browser == null) return true;
            if (!ready || Core == null) return false;
            if (flush != null) return await flush.Task;
            flushId = Guid.NewGuid().ToString("N");
            var pending = new TaskCompletionSource<bool>(); flush = pending;
            try {
                var execute = Core.ExecuteScriptAsync("(async()=>{let saved=false;try{saved=(await window.__LINKSHELL_DESKTOP_FLUSH__()).saved===true;}catch{}window.chrome.webview.postMessage({action:'flushed',id:" + Desktop.Json.Serialize(flushId) + ",saved});})()");
                if (await Task.WhenAny(execute, Task.Delay(5000)) != execute) { pending.TrySetResult(false); return false; }
                await execute;
                if (await Task.WhenAny(pending.Task, Task.Delay(35000)) != pending.Task) pending.TrySetResult(false);
                return await pending.Task;
            } catch (Exception) { pending.TrySetResult(false); return false; }
            finally { flush = null; flushId = null; }
        }
        public async Task<bool> CanDiscard(string action) {
            if (await Flush()) return true;
            return MessageBox.Show(Window.GetWindow(this), "部分草稿或设置尚未保存。选择“否”返回并重试保存；选择“是”会丢弃未保存的改动并" + action + "。", "未保存的工作台改动", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No) == MessageBoxResult.Yes;
        }
        public async Task Stop() {
            ready = false;
            if (browser != null) { Children.Remove(browser); browser.Dispose(); browser = null; }
            var child = sidecar; sidecar = null;
            if (child != null) {
                try { child.StandardInput.Close(); if (!await Task.Run(() => child.WaitForExit(4000))) child.Kill(); }
                catch (InvalidOperationException) { }
                finally { child.Dispose(); }
            }
        }
        public void Dispose() { disposed = true; if (browser != null) browser.Dispose(); if (sidecar != null) { try { sidecar.StandardInput.Close(); } catch (InvalidOperationException) {} } }
    }
}
