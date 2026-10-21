using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace LinkShell.Windows {
    internal static class WorkspaceTests {
        static void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
        [STAThread] static void Main(string[] args) {
            try {
                var url = WorkspacePolicy.Ready("{\"url\":\"http://127.0.0.1:54321/#desktop=abcdefghijklmnopqrstuvwxyz012345\"}");
                var policy = new WorkspacePolicy(url);
                Check(policy.Trusted("http://127.0.0.1:54321/"), "main origin");
                foreach (string source in new[] { "http://localhost:54321/", "http://127.0.0.1:54322/", "https://127.0.0.1:54321/", "http://user@127.0.0.1:54321/", "file:///C:/test", "about:srcdoc", "https://evil.example/" }) Check(!policy.Trusted(source), "untrusted origin: " + source);
                Check(policy.Download("blob:http://127.0.0.1:54321/id"), "workspace blob download");
                Check(!policy.Download("blob:null/id"), "opaque frame download");
                foreach (string source in new[] { "file:///C:/test", "javascript:alert(1)", "http://127.0.0.1/", "http://[::1]/", "http://localhost/", "http://x.localhost/", "https://user:pass@example.com/", "http://169.254.1.1/" }) Check(!WorkspacePolicy.External(source), "external policy: " + source);
                Check(WorkspacePolicy.External("https://github.com/LiuTianjie/LinkShell"), "external https");
                Console.WriteLine("Workspace origin, download and external-navigation policy passed.");
                if (args.Length == 0) return;
                RunNative();
            } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        }
        static async Task<string> Eval(Workspace workspace, string script) { return await workspace.Core.ExecuteScriptAsync(script); }
        static async Task Until(Workspace workspace, string script, string reason, int seconds = 35) {
            var watch = Stopwatch.StartNew();
            while (watch.Elapsed.TotalSeconds < seconds) {
                if (workspace.Ready && await Eval(workspace, script) == "true") return;
                await Task.Delay(100);
            }
            throw new Exception("Timed out: " + reason);
        }
        static void RunNative() {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            int management = 0; string appearance = "";
            var workspace = new Workspace(() => management++, value => appearance = value);
            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            var window = new Window { Title = "LinkShell workspace QA", Width = 1040, Height = 790, Content = workspace };
            window.Loaded += async (s, e) => {
                Exception failure = null;
                try {
                    await workspace.SetState(true, "dark"); await workspace.Start();
                    await Until(workspace, "document.body.innerText.includes('工作空间') && document.body.innerText.includes('Windows 工作台 QA')", "local named-pipe session list");
                    Check(await Eval(workspace, "window.__LINKSHELL_CONFIG__.desktopPlatform==='win32' && !location.hash.includes('desktop=')") == "true", "platform and capability removal");
                    Check(await Eval(workspace, "Math.round(document.querySelector('.desktop-sidebar').getBoundingClientRect().width)===232 && Math.round(document.querySelector('.windows-desktop-header').getBoundingClientRect().height)===104") == "true", "shared sidebar/header dimensions");
                    await Eval(workspace, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Windows 工作台 QA'))?.click()");
                    await Until(workspace, "document.body.innerText.includes('工作台历史消息') && !!document.querySelector('textarea')", "Codex conversation and history");
                    await Eval(workspace, "(()=>{const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Windows 草稿保留测试');t.dispatchEvent(new Event('input',{bubbles:true}));})()");
                    await Task.Delay(600);
                    Check(await workspace.Flush(), "real draft flush");
                    Check(File.ReadAllText(Path.Combine(Desktop.Home, "desktop-client.json")).Contains("Windows 草稿保留测试"), "draft persisted to disk");
                    await workspace.SetState(false, "dark"); await Task.Delay(200); await workspace.SetState(true, "light");
                    Check(await Eval(workspace, "document.querySelector('textarea').value==='Windows 草稿保留测试' && window.__LINKSHELL_DESKTOP_VISIBLE__===true") == "true", "draft retained across management/visibility changes");
                    await Eval(workspace, "(()=>{const f=document.createElement('iframe');f.sandbox='allow-scripts';f.srcdoc='<script>try{chrome.webview.postMessage({action:\"manage\"})}catch{}</script>';document.body.append(f)})()");
                    await Task.Delay(300); Check(management == 0, "subframe cannot invoke management");
                    await Eval(workspace, "document.querySelector('iframe[sandbox]')?.remove()");
                    await Eval(workspace, "window.chrome.webview.postMessage({action:'manage'});window.chrome.webview.postMessage({action:'appearance',value:'light'})");
                    await Task.Delay(100); Check(management == 1 && appearance == "light", "main frame bridge");
                    await Eval(workspace, "window.__LINKSHELL_DESKTOP_FLUSH__=async()=>{await new Promise(r=>setTimeout(r,180));return {saved:false,pending:1}};");
                    var delay = Stopwatch.StartNew(); Check(!await workspace.Flush() && delay.ElapsedMilliseconds >= 150, "save failure acknowledgement awaited");
                    await Eval(workspace, "window.__LINKSHELL_DESKTOP_FLUSH__=async()=>({saved:true,pending:0})"); Check(await workspace.Flush(), "retry acknowledgement");
                    string output = Environment.GetEnvironmentVariable("LINKSHELL_WORKSPACE_QA_OUTPUT");
                    if (!String.IsNullOrEmpty(output)) using (var image = File.Create(output)) await workspace.Core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
                    if (Environment.GetEnvironmentVariable("LINKSHELL_WORKSPACE_QA_SCREEN") == "1") {
                        await Eval(workspace, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='远程桌面')?.click()");
                        await Until(workspace, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='打开桌面'&&!b.disabled)", "screen access");
                        await Eval(workspace, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='打开桌面')?.click()");
                        await Until(workspace, "document.querySelector('.screen-signal')?.textContent.includes('视频直连') && /接收 [1-9][0-9]* 帧/.test(document.querySelector('.screen-metrics')?.textContent||'')", "WebView2 WebRTC video", 50);
                        Console.WriteLine("WebView2 real screen: " + await Eval(workspace, "document.querySelector('.screen-caption').textContent"));
                        await workspace.SetState(false, "light");
                        await Until(workspace, "!document.querySelector('.screen-stage iframe') && !document.querySelector('.screen-page iframe')", "hidden desktop releases receiver");
                        await workspace.SetState(true, "light");
                        await Until(workspace, "document.querySelector('.screen-signal')?.textContent.includes('视频直连')", "visible desktop reconnects video", 50);
                        await workspace.SetState(false, "light");
                        Console.WriteLine("Real screen hidden/reconnect lifecycle passed.");
                    }
                    Console.WriteLine("Native WebView2: local sessions/history, draft persistence, visibility, dimensions, iframe isolation, bridge and save acknowledgements passed.");
                } catch (Exception error) { failure = error; }
                await workspace.Stop(); workspace.Dispose(); window.Close();
                if (failure != null) { Console.Error.WriteLine(failure); Environment.ExitCode = 1; }
                app.Shutdown();
            };
            app.Run(window);
        }
    }
}
