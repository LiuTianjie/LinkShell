using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace LinkShell.Windows {
    // The downloaded installer takes over only after its own window is ready and the desktop exits.
    internal sealed class InstallerUpdate : IDisposable {
        static InstallerUpdate() {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        }
        public readonly string Target, Home, Ready;
        readonly Process parent;
        bool announced;

        InstallerUpdate(string target, string home, string ready, Process waiting) {
            Target = target; Home = home; Ready = ready; parent = waiting;
        }

        internal static InstallerUpdate Parse(string[] args) {
            if (args.Length == 0) return null;
            if (args[0] != "--update") throw new ArgumentException("无法识别安装参数，请重新打开安装程序。");
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int i = 1; i < args.Length; i += 2) {
                string key = args[i];
                if ((key != "--target" && key != "--home" && key != "--ready" && key != "--wait-pid") || i + 1 >= args.Length || values.ContainsKey(key)) throw new ArgumentException("更新参数不完整或重复。");
                values.Add(key, args[i + 1]);
            }
            if (values.Count != 4) throw new ArgumentException("更新参数不完整。");
            int pid;
            if (!Int32.TryParse(values["--wait-pid"], out pid) || pid <= 0 || pid == Process.GetCurrentProcess().Id) throw new ArgumentException("更新进程参数无效。");
            string target = Absolute(values["--target"]), home = Absolute(values["--home"]), ready = Absolute(values["--ready"]);
            if (String.Equals(target, Path.GetPathRoot(target), StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("更新目录无效。");
            if (String.Equals(home, target, StringComparison.OrdinalIgnoreCase) || home.StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("LinkShell 数据目录位于应用目录内，请先将数据移到应用目录外再更新。");
            foreach (string file in new[] { "LinkShell.exe", "resources/app/package.json", "LinkShell.Screen.exe", "standalone.json", "runtime/node.exe", "runtime/cli/dist/cli/src/index.js" }) {
                if (!File.Exists(Path.Combine(target, file))) throw new IOException("更新目录不是完整的 LinkShell 桌面安装：" + target);
            }
            EnsureDataOutsideBundle(target, home);
            string installer = Process.GetCurrentProcess().MainModule.FileName;
            string installerDirectory = Path.GetDirectoryName(installer);
            if (!String.Equals(Path.GetDirectoryName(ready), installerDirectory, StringComparison.OrdinalIgnoreCase) || Path.GetFileName(ready) != "ready" || File.Exists(ready)) throw new ArgumentException("更新交接文件位置无效。");
            if (installerDirectory.StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || String.Equals(installerDirectory, target, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("请从安装目录外启动更新程序。");
            Process waiting = null;
            try {
                try { waiting = Process.GetProcessById(pid); }
                catch (ArgumentException) { }
                if (waiting != null) {
                    try {
                        if (!waiting.HasExited && !String.Equals(waiting.MainModule.FileName, Path.Combine(target, "LinkShell.exe"), StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("请求更新的进程与安装目录不匹配。");
                    } catch (InvalidOperationException) {
                        if (!waiting.HasExited) throw;
                    }
                }
                return new InstallerUpdate(target, home, ready, waiting);
            } catch { if (waiting != null) waiting.Dispose(); throw; }
        }

        static string Absolute(string value) {
            if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value) || value.IndexOf('"') >= 0) throw new ArgumentException("更新路径必须是完整路径。");
            bool drive = value.Length >= 3 && Char.IsLetter(value[0]) && value[1] == ':' && (value[2] == '\\' || value[2] == '/');
            if (!drive && !value.StartsWith(@"\\", StringComparison.Ordinal)) throw new ArgumentException("更新路径必须是完整路径。");
            string full = Path.GetFullPath(value);
            return String.Equals(full, Path.GetPathRoot(full), StringComparison.OrdinalIgnoreCase) ? full : full.TrimEnd(Path.DirectorySeparatorChar);
        }

        [StructLayout(LayoutKind.Sequential)]
        struct HandleFileInformation {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
            public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleFileInformation information);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        static extern uint GetFileAttributesW(string name);

        static void EnsureDataOutsideBundle(string target, string home) {
            string realTarget = ResolvedDirectory(target, false), realHome = ResolvedDirectory(home, true);
            if (String.Equals(realTarget, Path.GetPathRoot(realTarget), StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("应用目录实际指向磁盘根目录，无法安全更新。");
            if (String.Equals(realHome, realTarget, StringComparison.OrdinalIgnoreCase) || realHome.StartsWith(realTarget.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("LinkShell 数据目录实际位于应用目录内，请先将数据移到应用目录外再更新。");
        }

        static string ResolvedDirectory(string path, bool allowMissingTail) {
            var tail = new List<string>();
            string candidate = path;
            while (true) {
                // Follow junctions in every ancestor. A lexical check can otherwise approve a data
                // directory which the install transaction will rename and remove with the old bundle.
                using (var handle = CreateFileW(candidate, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
                    if (!handle.IsInvalid) {
                        HandleFileInformation information;
                        if (!GetFileInformationByHandle(handle, out information)) throw PathFailure(candidate, Marshal.GetLastWin32Error());
                        if ((information.Attributes & 0x10) == 0) throw new IOException("更新路径不是目录：" + candidate);
                        var buffer = new StringBuilder(512);
                        uint size = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
                        if (size == 0) throw PathFailure(candidate, Marshal.GetLastWin32Error());
                        if (size >= buffer.Capacity) {
                            if (size > 32768) throw new IOException("无法验证更新目录的实际位置：路径过长。");
                            buffer = new StringBuilder((int)size + 1);
                            size = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
                            if (size == 0) throw PathFailure(candidate, Marshal.GetLastWin32Error());
                            if (size >= buffer.Capacity) throw new IOException("无法验证更新目录的实际位置：路径发生变化。");
                        }
                        string resolved = buffer.ToString();
                        if (resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) resolved = @"\\" + resolved.Substring(8);
                        else if (resolved.StartsWith(@"\\?\", StringComparison.Ordinal) && resolved.Length >= 6 && resolved[5] == ':') resolved = resolved.Substring(4);
                        for (int i = tail.Count - 1; i >= 0; i--) resolved = Path.Combine(resolved, tail[i]);
                        return String.Equals(resolved, Path.GetPathRoot(resolved), StringComparison.OrdinalIgnoreCase) ? resolved : resolved.TrimEnd('\\');
                    }
                    int error = Marshal.GetLastWin32Error();
                    if (!allowMissingTail || (error != 2 && error != 3)) throw PathFailure(candidate, error);
                    uint attributes = GetFileAttributesW(candidate);
                    int attributesError = Marshal.GetLastWin32Error();
                    // An existing but unresolvable junction is not a missing data-directory suffix.
                    if (attributes != UInt32.MaxValue || (attributesError != 2 && attributesError != 3)) throw PathFailure(candidate, attributes == UInt32.MaxValue ? attributesError : error);
                }
                string ancestor = Path.GetDirectoryName(candidate);
                if (String.IsNullOrEmpty(ancestor) || String.Equals(ancestor, candidate, StringComparison.OrdinalIgnoreCase)) throw new IOException("无法验证更新目录的实际位置：" + path);
                tail.Add(Path.GetFileName(candidate));
                candidate = ancestor;
            }
        }

        static IOException PathFailure(string path, int error) { return new IOException("无法验证更新目录的实际位置：" + path + "\n" + new Win32Exception(error).Message); }

        internal void ValidatePaths() { EnsureDataOutsideBundle(Target, Home); }

        internal void AnnounceReady() {
            if (announced) return;
            ValidatePaths();
            using (var output = new FileStream(Ready, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
                byte[] bytes = Encoding.ASCII.GetBytes(Process.GetCurrentProcess().Id.ToString());
                output.Write(bytes, 0, bytes.Length);
                output.Flush(true);
            }
            announced = true;
        }

        internal void WaitForDesktopExit(CancellationToken cancellation) {
            var elapsed = Stopwatch.StartNew();
            while (parent != null && !parent.HasExited) {
                cancellation.ThrowIfCancellationRequested();
                if (elapsed.ElapsedMilliseconds >= 60000) throw new TimeoutException("LinkShell 尚未退出。请保存内容并从托盘退出，再点击重试更新。");
                parent.WaitForExit(200);
            }
            // Chromium's renderer/GPU children can outlive the main process briefly and still hold the bundle.
            while (DesktopRunning()) {
                cancellation.ThrowIfCancellationRequested();
                if (elapsed.ElapsedMilliseconds >= 60000) throw new TimeoutException("LinkShell 后台窗口进程尚未退出，请稍后点击重试更新。");
                cancellation.WaitHandle.WaitOne(200);
            }
            cancellation.ThrowIfCancellationRequested();
            ValidatePaths();
        }

        bool DesktopRunning() {
            foreach (var process in Process.GetProcessesByName("LinkShell")) {
                using (process) {
                    try {
                        if (!process.HasExited && String.Equals(process.MainModule.FileName, Path.Combine(Target, "LinkShell.exe"), StringComparison.OrdinalIgnoreCase)) return true;
                    } catch (InvalidOperationException) { if (!process.HasExited) throw; }
                }
            }
            return false;
        }

        internal void Launch() {
            var start = new ProcessStartInfo(Path.Combine(Target, "LinkShell.exe"), "--home " + Quote(Home)) { UseShellExecute = false, WorkingDirectory = Target };
            start.EnvironmentVariables["LINKSHELL_HOME"] = Home;
            using (var process = Process.Start(start)) { if (process == null) throw new IOException("未能启动 LinkShell。"); }
        }

        // Windows doubles backslashes before the closing quote, including a home at a drive root.
        static string Quote(string value) { return "\"" + value.TrimEnd('\\') + new string('\\', 2 * (value.Length - value.TrimEnd('\\').Length)) + "\""; }
        public void Dispose() { if (parent != null) parent.Dispose(); }
    }
}
