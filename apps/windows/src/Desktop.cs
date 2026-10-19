using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using Microsoft.Win32;

namespace LinkShell.Windows {
    internal static class Desktop {
        static Desktop() {}
        public static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        public static readonly string Home = Environment.GetEnvironmentVariable("LINKSHELL_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".linkshell");
        public static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        [STAThread] static void Main(string[] args) {


            string key;
            using (var hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Home.ToLowerInvariant()))).Replace("-", "").Substring(0, 20);
            bool created;
            using (var single = new Mutex(true, "Local\\LinkShell-" + key, out created)) {
                if (!created) {
                    try { using (var signal = EventWaitHandle.OpenExisting("Local\\LinkShell-Activate-" + key)) signal.Set(); }
                    catch (WaitHandleCannotBeOpenedException) { MessageBox.Show("LinkShell 正在启动，请稍后从托盘打开。", "LinkShell"); }
                    return;
                }
                try {
                    Directory.CreateDirectory(Home);
                    using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\LinkShell-Activate-" + key)) {
                        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                        var dashboard = new Dashboard(args.Contains("--hidden"));
                        var listener = ThreadPool.RegisterWaitForSingleObject(signal, (state, timeout) => app.Dispatcher.BeginInvoke(new Action(dashboard.Restore)), null, -1, false);
                        try { app.Run(dashboard); } finally { listener.Unregister(null); }
                    }
                }
                catch (Exception error) { MessageBox.Show(error.Message, "LinkShell", MessageBoxButton.OK, MessageBoxImage.Error); }
            }
        }
        public static string Quote(string value) {
            var result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
        public static Process Cli(string action) {
            string node = Environment.GetEnvironmentVariable("LINKSHELL_DESKTOP_NODE") ?? Path.Combine(Root, "runtime", "node.exe");
            string cli = Environment.GetEnvironmentVariable("LINKSHELL_DESKTOP_CLI") ?? Path.Combine(Root, "runtime", "cli", "dist", "cli", "src", "index.js");
            if (!File.Exists(node) || !File.Exists(cli)) throw new FileNotFoundException("内置运行环境缺失，请重新安装 LinkShell。开发环境请设置 LINKSHELL_DESKTOP_NODE 和 LINKSHELL_DESKTOP_CLI。");
            var start = new ProcessStartInfo(node, Quote(cli) + " desktop --action " + Quote(action)) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = Home
            };
            start.EnvironmentVariables["LINKSHELL_HOME"] = Home;
            start.EnvironmentVariables["LINKSHELL_APP_BUNDLE"] = Root;
            start.EnvironmentVariables["LINKSHELL_WINDOWS_HELPER"] = Path.Combine(Root, "LinkShell.Screen.exe");
            return Process.Start(start);
        }
        public static Dictionary<string, object> Map(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
        public static object Get(object value, string key) { object found; return Map(value).TryGetValue(key, out found) ? found : null; }
        public static string Text(object value, string key) { return Convert.ToString(Get(value, key)) ?? ""; }
        public static IEnumerable<object> Items(object value) { return (value as IEnumerable ?? new object[0]).Cast<object>(); }
    }

}
