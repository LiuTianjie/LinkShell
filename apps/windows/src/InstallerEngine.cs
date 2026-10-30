using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace LinkShell.Windows {
    internal sealed class InstallProgress {
        public readonly int Percent;
        public readonly string Stage, Detail;
        public InstallProgress(int percent, string stage, string detail) { Percent = percent; Stage = stage; Detail = detail; }
    }

    // UI and tests share the same extraction and replacement transaction.
    internal sealed class InstallerEngine {
        static InstallerEngine() {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        }
        public readonly string Destination;
        readonly Func<Stream> payload;
        readonly Action<string, string> runCli;
        readonly Action<string> shortcut, checkRunning;

        public InstallerEngine(string destination, Func<Stream> archive, Action<string, string> cli = null, Action<string> createShortcut = null, Action<string> running = null, string home = null) {
            Destination = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar);
            payload = archive; runCli = cli ?? ((root, action) => RunCli(root, action, home)); shortcut = createShortcut ?? (root => CreateShortcut(root, home)); checkRunning = running ?? CheckRunning;
        }

        public void Install(IProgress<InstallProgress> progress, CancellationToken token, Action enterCommit) {
            // Stage beside the destination, so directory renames stay on the same volume.
            string scratch = Destination + ".install-" + Guid.NewGuid().ToString("N");
            string backup = Destination + ".previous-" + Guid.NewGuid().ToString("N");
            bool replacing = false, prepared = false;
            try {
                CheckDestination(); checkRunning(Destination); token.ThrowIfCancellationRequested();
                Report(progress, 2, "检查安装环境", "正在检查文件和磁盘空间…");
                using (var stream = payload()) {
                    if (stream == null) throw new InvalidDataException("安装文件缺失，请重新下载安装包。");
                    using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
                        foreach (var entry in zip.Entries) SafePath(scratch, entry.FullName);
                        long total = zip.Entries.Sum(entry => entry.Length);
                        if (new DriveInfo(Path.GetPathRoot(Destination)).AvailableFreeSpace < total + 16 * 1024 * 1024) throw new IOException("磁盘空间不足，请释放至少 " + Megabytes(total + 16 * 1024 * 1024) + " MB 空间后重试。");
                        Directory.CreateDirectory(IOPath(scratch));
                        Extract(zip, scratch, total, progress, token);
                    }
                }
                foreach (string file in new[] { "LinkShell.exe", "resources/app/package.json", "LinkShell.Screen.exe", "standalone.json", "runtime/node.exe", "runtime/cli/dist/cli/src/index.js" }) {
                    if (!File.Exists(IOPath(Path.Combine(scratch, file)))) throw new InvalidDataException("安装包不完整，缺少 " + file + "。请重新下载安装包。");
                }
                token.ThrowIfCancellationRequested();
                CheckDestination(); checkRunning(Destination);
                replacing = File.Exists(Path.Combine(Destination, "standalone.json"));
                enterCommit();
                Report(progress, 88, replacing ? "准备更新后台服务" : "写入应用", replacing ? "保存服务状态、机器身份和设备配对…" : "正在写入 LinkShell…");
                try {
                    if (replacing) { prepared = true; runCli(Destination, "prepare-update"); MoveBundle(Destination, backup); }
                    Directory.CreateDirectory(Path.GetDirectoryName(Destination));
                    MoveBundle(scratch, Destination);
                    Report(progress, 94, "恢复后台服务", replacing ? "检查服务恢复与配对信息…" : "正在完成安装…");
                    if (replacing) runCli(Destination, "recover-update");
                } catch (Exception installError) {
                    Report(progress, 94, "正在恢复原有安装", "请保持窗口打开…");
                    try {
                        if (Directory.Exists(backup)) {
                            if (Directory.Exists(Destination)) {
                                runCli(Destination, "stop-update-host");
                                MoveBundle(Destination, Destination + ".failed-" + Guid.NewGuid().ToString("N"));
                            }
                            MoveBundle(backup, Destination);
                        }
                        if (prepared) runCli(Destination, "recover-update");
                    } catch (Exception recoveryError) {
                        throw new IOException("安装失败，自动恢复未完成。请保留安装目录和旁边的 previous / failed 副本。\n安装：" + installError.Message + "\n恢复：" + recoveryError.Message, installError);
                    }
                    throw new IOException((prepared ? "更新失败，已恢复原有安装。\n" : "安装失败。\n") + installError.Message, installError);
                }
                // The new bundle's CLI has run, so no rollback needs the old copies. Each one is a whole app.
                RemoveOldBundles(progress);
                Report(progress, 98, "创建开始菜单入口", "正在添加 LinkShell 快捷方式…");
                try { shortcut(Destination); }
                catch (Exception error) { throw new IOException("应用文件已安装，但无法创建开始菜单入口。可从安装目录运行 LinkShell.exe，或重试安装。\n" + error.Message, error); }
                Report(progress, 100, "安装完成", "已创建开始菜单快捷方式");
            } finally {
                if (Directory.Exists(IOPath(scratch))) RetryFileOperation(() => Directory.Delete(IOPath(scratch), true));
            }
        }

        void CheckDestination() {
            if (Directory.Exists(Destination) && !File.Exists(Path.Combine(Destination, "standalone.json"))) throw new IOException("目标目录已存在且不属于 LinkShell，请先检查：" + Destination);
            if (File.Exists(Destination)) throw new IOException("安装位置被同名文件占用：" + Destination);
        }
        void RemoveOldBundles(IProgress<InstallProgress> progress) {
            string prefix = Path.GetFileName(Destination);
            DirectoryInfo[] old;
            try {
                old = new DirectoryInfo(IOPath(Path.GetDirectoryName(Destination))).GetDirectories(prefix + ".*")
                    .Where(directory => OldBundle(directory.Name, prefix) && (directory.Attributes & FileAttributes.ReparsePoint) == 0).ToArray();
            } catch (IOException) { return; } catch (UnauthorizedAccessException) { return; }
            if (old.Length == 0) return;
            Report(progress, 96, "清理旧版本", "正在删除上一版本的文件…");
            foreach (var directory in old) {
                // A file something still holds keeps its copy; the next install tries again.
                try { RetryFileOperation(() => Directory.Delete(directory.FullName, true)); }
                catch (IOException) {} catch (UnauthorizedAccessException) {}
            }
        }
        static bool OldBundle(string name, string prefix) {
            foreach (string kind in new[] { ".previous-", ".failed-" }) {
                string head = prefix + kind;
                if (name.Length == head.Length + 32 && name.StartsWith(head, StringComparison.OrdinalIgnoreCase) && name.Substring(head.Length).All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return true;
            }
            return false;
        }
        static void MoveBundle(string source, string destination) { RetryFileOperation(() => Directory.Move(IOPath(source), IOPath(destination))); }
        static string IOPath(string path) {
            // Extended paths work without changing the machine-wide long-path policy.
            if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
            return path.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + Path.GetFullPath(path);
        }
        static void RetryFileOperation(Action action) {
            // Scanners can briefly hold a freshly extracted executable after its stream closes.
            for (int attempt = 0; ; attempt++) {
                try { action(); return; }
                catch (IOException error) { if (attempt >= 5 || !TransientFileError(error)) throw; }
                catch (UnauthorizedAccessException error) { if (attempt >= 5 || !TransientFileError(error)) throw; }
                Thread.Sleep(100 * (attempt + 1));
            }
        }
        static bool TransientFileError(Exception error) { int code = error.HResult & 0xffff; return code == 5 || code == 32 || code == 33; }
        static string SafePath(string root, string entry) {
            string path = Path.GetFullPath(Path.Combine(root, entry));
            if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && !String.Equals(path.TrimEnd(Path.DirectorySeparatorChar), root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装包包含无效的文件路径。");
            return path;
        }
        static string Megabytes(long bytes) { return (bytes / 1048576d).ToString("0.0"); }
        static void Report(IProgress<InstallProgress> progress, int value, string stage, string detail) { progress.Report(new InstallProgress(value, stage, detail)); }
        static void Extract(ZipArchive zip, string root, long total, IProgress<InstallProgress> progress, CancellationToken token) {
            long done = 0; int files = 0, count = zip.Entries.Count(entry => !entry.FullName.EndsWith("/"));
            var clock = Stopwatch.StartNew(); long last = -100; var buffer = new byte[131072];
            foreach (var entry in zip.Entries) {
                token.ThrowIfCancellationRequested();
                string path = SafePath(root, entry.FullName);
                if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(IOPath(path)); continue; }
                Directory.CreateDirectory(IOPath(Path.GetDirectoryName(path)));
                using (var input = entry.Open()) using (var output = new FileStream(IOPath(path), FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) != 0) {
                        token.ThrowIfCancellationRequested(); output.Write(buffer, 0, read); done += read;
                        if (clock.ElapsedMilliseconds - last >= 80) {
                            last = clock.ElapsedMilliseconds;
                            Report(progress, 5 + (int)(80d * done / Math.Max(1, total)), "正在解压安装文件", Megabytes(done) + " / " + Megabytes(total) + " MB  ·  " + files + " / " + count + " 个文件  ·  " + Path.GetFileName(path));
                        }
                    }
                }
                files++;
            }
            Report(progress, 85, "文件解压完成", Megabytes(done) + " MB  ·  " + files + " 个文件");
        }
        static void CheckRunning(string root) {
            foreach (var process in Process.GetProcessesByName("LinkShell")) {
                try {
                    if (!process.HasExited && String.Equals(process.MainModule.FileName, Path.Combine(root, "LinkShell.exe"), StringComparison.OrdinalIgnoreCase)) throw new IOException("LinkShell 界面仍在运行。请先从系统托盘退出，再点击重试安装。");
                } finally { process.Dispose(); }
            }
        }
        static void CreateShortcut(string root, string home) {
            CreateShortcutAt(root, Environment.GetFolderPath(Environment.SpecialFolder.Programs), home);
        }
        internal static void CreateShortcutAt(string root, string directory, string home = null) {
            Directory.CreateDirectory(directory);
            object shell = null, link = null;
            string step = "加载 Windows 快捷方式组件";
            try {
                Type type = Type.GetTypeFromProgID("WScript.Shell"); shell = Activator.CreateInstance(type);
                step = "创建开始菜单快捷方式";
                link = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { Path.Combine(directory, "LinkShell.lnk") });
                step = "设置快捷方式目标";
                link.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { Path.Combine(root, "LinkShell.exe") });
                step = "设置快捷方式工作目录";
                link.GetType().InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { root });
                if (home != null) {
                    step = "设置快捷方式启动参数";
                    link.GetType().InvokeMember("Arguments", BindingFlags.SetProperty, null, link, new object[] { "--home " + Quote(home) });
                }
                step = "保存开始菜单快捷方式";
                link.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
            } catch (Exception error) {
                // Reflection otherwise hides the actionable COM error behind a generic invocation failure.
                Exception cause = error;
                while (cause is TargetInvocationException && cause.InnerException != null) cause = cause.InnerException;
                throw new IOException(step + "失败（0x" + cause.HResult.ToString("X8") + "）：" + cause.Message, cause);
            } finally { if (link != null) Marshal.FinalReleaseComObject(link); if (shell != null) Marshal.FinalReleaseComObject(shell); }
        }
        static string Quote(string value) { return "\"" + value.TrimEnd('\\') + new string('\\', 2 * (value.Length - value.TrimEnd('\\').Length)) + "\""; }
        static void RunCli(string root, string action, string home) {
            var start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), "\"" + Path.Combine(root, "runtime", "cli", "dist", "cli", "src", "index.js") + "\" desktop --action " + action) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            start.EnvironmentVariables["LINKSHELL_APP_BUNDLE"] = root;
            start.EnvironmentVariables["LINKSHELL_WINDOWS_HELPER"] = Path.Combine(root, "LinkShell.Screen.exe");
            if (home != null) start.EnvironmentVariables["LINKSHELL_HOME"] = home;
            using (var child = Process.Start(start)) {
                var output = child.StandardOutput.ReadToEndAsync(); var errors = child.StandardError.ReadToEndAsync();
                if (!child.WaitForExit(60000)) { child.Kill(); child.WaitForExit(); throw new TimeoutException("停止或恢复后台服务超时，请检查服务状态。"); }
                if (child.ExitCode != 0) throw new IOException(output.Result + errors.Result);
            }
        }
    }
}
