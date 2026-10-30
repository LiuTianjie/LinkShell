using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using LinkShell.Windows;

internal static class InstallerTests {
    sealed class Updates : IProgress<InstallProgress> {
        public readonly List<InstallProgress> Values = new List<InstallProgress>();
        public Action<InstallProgress> OnUpdate;
        public void Report(InstallProgress value) { Values.Add(value); if (OnUpdate != null) OnUpdate(value); }
    }
    static void Assert(bool test, string message) { if (!test) throw new Exception(message); }
    static void Throws<T>(Action action) where T : Exception { try { action(); } catch (T error) { Console.WriteLine(error.Message); return; } throw new Exception("Expected " + typeof(T).Name); }
    static Stream Payload(bool complete = true, bool traversal = false, bool longPath = false) {
        var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, true)) {
            foreach (string name in complete ? new[] { "LinkShell.exe", "resources/app/package.json", "LinkShell.Screen.exe", "standalone.json", "runtime/node.exe", "runtime/cli/dist/cli/src/index.js" } : new[] { "standalone.json" }) {
                using (var writer = new StreamWriter(zip.CreateEntry("./" + name).Open())) writer.Write("new");
            }
            using (var output = zip.CreateEntry("runtime/large.bin").Open()) output.Write(new byte[2 * 1024 * 1024], 0, 2 * 1024 * 1024);
            if (traversal) using (var writer = new StreamWriter(zip.CreateEntry("../escaped.txt").Open())) writer.Write("bad");
            if (longPath) using (var writer = new StreamWriter(zip.CreateEntry(String.Join("/", Enumerable.Repeat(new string('a', 35), 8)) + "/module.js").Open())) writer.Write("long");
        }
        stream.Position = 0; return stream;
    }
    static void Old(string path) { Directory.CreateDirectory(path); File.WriteAllText(Path.Combine(path, "standalone.json"), "old"); File.WriteAllText(Path.Combine(path, "LinkShell.exe"), "old"); }
    static string Copy(string kind) { return "LinkShell." + kind + "-" + Guid.NewGuid().ToString("N"); }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern uint GetShortPathNameW(string path, StringBuilder result, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern uint GetLongPathNameW(string path, StringBuilder result, uint length);

    static string PathSpelling(string path, bool shortName) {
        var buffer = new StringBuilder(512);
        uint size = shortName ? GetShortPathNameW(path, buffer, (uint)buffer.Capacity) : GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
        if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resolve shortcut fixture path: " + path);
        if (size >= buffer.Capacity) {
            buffer = new StringBuilder((int)size + 1);
            size = shortName ? GetShortPathNameW(path, buffer, (uint)buffer.Capacity) : GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
            if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resolve shortcut fixture path: " + path);
            Assert(size < buffer.Capacity, "shortcut fixture path changed while reading");
        }
        return buffer.ToString();
    }

    // Keep the reader's ABI independent of production so a writer declaration mistake cannot validate itself.
    // HRESULTs are translated into exceptions: these methods deliberately do not use PreserveSig.
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShortcutReadback {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, IntPtr findData, uint flags);
        void GetIDList(out IntPtr itemIdList);
        void SetIDList(IntPtr itemIdList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int capacity);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int capacity);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int capacity);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out ushort hotkey);
        void SetHotkey(ushort hotkey);
        void GetShowCmd(out int command);
        void SetShowCmd(int command);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    static string[] ReadShortcut(string path) {
        object shortcut = null;
        string step = "create Unicode Shell Link for shortcut readback";
        try {
            shortcut = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
            var link = (IShortcutReadback)shortcut;
            step = "open saved shortcut for readback";
            ((System.Runtime.InteropServices.ComTypes.IPersistFile)shortcut).Load(path, 0);
            var target = new StringBuilder(32768); var workingDirectory = new StringBuilder(32768); var arguments = new StringBuilder(32768);
            step = "read shortcut TargetPath";
            link.GetPath(target, target.Capacity, IntPtr.Zero, 4); // SLGP_RAWPATH avoids resolving or updating the saved target.
            step = "read shortcut WorkingDirectory";
            link.GetWorkingDirectory(workingDirectory, workingDirectory.Capacity);
            step = "read shortcut Arguments";
            link.GetArguments(arguments, arguments.Capacity);
            string[] fields = { "TargetPath", "WorkingDirectory", "Arguments" }, values = { target.ToString(), workingDirectory.ToString(), arguments.ToString() };
            for (int index = 0; index < fields.Length; index++) Console.WriteLine(fields[index] + "=[" + values[index] + "]");
            return values;
        } catch (Exception error) {
            Exception cause = error;
            while (cause is TargetInvocationException && cause.InnerException != null) cause = cause.InnerException;
            throw new IOException(step + " failed (" + cause.GetType().FullName + ", 0x" + cause.HResult.ToString("X8") + "): " + cause.Message, cause);
        } finally { if (shortcut != null) Marshal.FinalReleaseComObject(shortcut); }
    }

    static void AssertShortcut(string directory, string target, string home) {
        string path = Path.Combine(directory, "LinkShell.lnk");
        Assert(File.Exists(path) && new FileInfo(path).Length > 0, "native shortcut missing: " + path);
        string[] values = ReadShortcut(path);
        Assert(!String.IsNullOrEmpty(values[0]), "saved shortcut TargetPath is empty");
        Assert(!String.IsNullOrEmpty(values[1]), "saved shortcut WorkingDirectory is empty");
        Assert(String.Equals(PathSpelling(values[0], false), PathSpelling(Path.Combine(target, "LinkShell.exe"), false), StringComparison.OrdinalIgnoreCase), "shortcut target differs");
        Assert(String.Equals(PathSpelling(values[1], false), PathSpelling(target, false), StringComparison.OrdinalIgnoreCase), "shortcut working directory differs");
        Assert(values[2] == (home == null ? "" : "--home \"" + home + "\""), "shortcut arguments changed home spelling or quoting");
    }

    static void ShortcutHome(string rawRoot) {
        string destination = Path.Combine(Path.GetFullPath(rawRoot), "shortcut-home", "中文 安装", "LinkShell");
        Directory.CreateDirectory(destination);
        File.Copy(Assembly.GetExecutingAssembly().Location, Path.Combine(destination, "LinkShell.exe"));
        string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        Assert(!String.IsNullOrEmpty(programs) && Directory.Exists(programs), "current user's Programs directory is unavailable");
        string directory = Path.Combine(programs, "LinkShell QA shortcuts-" + Guid.NewGuid().ToString("N"));
        Assert(!Directory.Exists(directory) && !File.Exists(directory), "refusing to overwrite an existing Programs fixture");
        Directory.CreateDirectory(directory);
        Exception failure = null;
        try {
            // Keep the launcher's raw RUNNER~1 spelling; shortcut arguments also determine the host's data/pipe identity.
            string firstHome = Path.Combine(rawRoot, "shortcut-home", "自定义 数据", "home one");
            string secondHome = Path.Combine(PathSpelling(Path.GetFullPath(rawRoot), true), "shortcut-home", "自定义 数据", "home two");
            Directory.CreateDirectory(firstHome); Directory.CreateDirectory(secondHome);
            Console.WriteLine("shortcut-home raw root=[" + rawRoot + "]; Programs fixture=[" + directory + "]");
            Task.Run(() => {
                Assert(Thread.CurrentThread.GetApartmentState() == ApartmentState.MTA, "shortcut worker is not MTA");
                Console.WriteLine("shortcut-home apartment=" + Thread.CurrentThread.GetApartmentState());
                InstallerEngine.CreateShortcutAt(destination, directory, firstHome);
                AssertShortcut(directory, destination, firstHome);
                Assert(File.Exists(Path.Combine(directory, "LinkShell.lnk")), "owned shortcut missing before rewrite");
                InstallerEngine.CreateShortcutAt(destination, directory, secondHome);
                AssertShortcut(directory, destination, secondHome);
            }).GetAwaiter().GetResult();
        } catch (Exception error) { failure = error; throw; }
        finally {
            try { Directory.Delete(directory, true); }
            catch (Exception cleanupError) {
                if (failure == null) throw;
                Console.Error.WriteLine("Programs fixture cleanup also failed: " + cleanupError);
            }
        }
    }

    static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
        try {
            string scenario = args[0], root = Path.GetFullPath(args[1]), destination = Path.Combine(root, scenario, "LinkShell");
            if (scenario == "shortcut-home") { ShortcutHome(args[1]); Console.WriteLine("PASS " + scenario); return 0; }
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            var updates = new Updates(); var token = new CancellationTokenSource(); var calls = new List<string>(); bool committed = false, shortcut = false;
            Func<Stream> payload = () => Payload();
            Action<string, string> cli = (path, action) => { calls.Add(action); };
            Action<string> link = path => { shortcut = true; Assert(File.Exists(Path.Combine(path, "LinkShell.exe")), "shortcut before files"); };
            Action<string> running = path => {};
            Action commit = () => { token.Token.ThrowIfCancellationRequested(); committed = true; };
            if (new[] { "cancel", "cancel-at-commit", "update", "rollback", "prepare-failure", "locked", "transient-lock", "cleanup" }.Contains(scenario)) Old(destination);
            string parent = Path.GetDirectoryName(destination);
            string[] stale = { Copy("previous"), Copy("failed") }, unrelated = { "LinkShell.previous-notes", "Other.previous-" + Guid.NewGuid().ToString("N"), Copy("backup") };
            if (scenario == "cleanup" || scenario == "rollback") {
                foreach (string name in stale) Old(Path.Combine(parent, name));
                foreach (string name in unrelated) { Directory.CreateDirectory(Path.Combine(parent, name)); File.WriteAllText(Path.Combine(parent, name, "keep.txt"), "keep"); }
            }
            if (scenario == "cancel") updates.OnUpdate = value => { if (value.Percent >= 5 && value.Percent < 85) token.Cancel(); };
            if (scenario == "cancel-at-commit") commit = () => { token.Cancel(); token.Token.ThrowIfCancellationRequested(); };
            if (scenario == "traversal") payload = () => Payload(true, true);
            if (scenario == "long-path") payload = () => Payload(true, false, true);
            if (scenario == "incomplete") payload = () => Payload(false);
            if (scenario == "foreign") { Directory.CreateDirectory(destination); File.WriteAllText(Path.Combine(destination, "keep.txt"), "keep"); }
            if (scenario == "locked") running = path => { throw new IOException("running"); };
            if (scenario == "shortcut-failure") link = path => { throw new IOException("shortcut blocked"); };
            if (scenario == "shortcut-real") link = path => { InstallerEngine.CreateShortcutAt(path, Path.Combine(root, "shortcuts")); shortcut = true; };
            if (scenario == "prepare-failure") cli = (path, action) => { calls.Add(action); if (action == "prepare-update") throw new IOException("stop failed"); };
            if (scenario == "transient-lock") cli = (path, action) => {
                calls.Add(action);
                if (action == "prepare-update") {
                    var held = new FileStream(Path.Combine(path, "LinkShell.exe"), FileMode.Open, FileAccess.Read, FileShare.None);
                    var release = new Thread(() => { Thread.Sleep(250); held.Dispose(); }); release.Start();
                }
            };
            if (scenario == "rollback") cli = (path, action) => {
                calls.Add(action);
                if (action == "recover-update" && File.ReadAllText(Path.Combine(path, "LinkShell.exe")) == "new") throw new IOException("new host rejected");
            };
            var engine = new InstallerEngine(destination, payload, cli, link, running);
            Action install = () => engine.Install(updates, token.Token, commit);
            if (scenario.StartsWith("cancel")) Throws<OperationCanceledException>(install);
            else if (new[] { "rollback", "prepare-failure", "foreign", "locked", "shortcut-failure" }.Contains(scenario)) Throws<IOException>(install);
            else if (new[] { "traversal", "incomplete" }.Contains(scenario)) Throws<InvalidDataException>(install);
            else install();

            Assert(!Directory.GetDirectories(Path.GetDirectoryName(destination), "*.install-*").Any(), "staging left behind");
            if (new[] { "fresh", "update", "transient-lock", "long-path", "shortcut-real", "cleanup" }.Contains(scenario)) {
                Assert(File.ReadAllText(Path.Combine(destination, "LinkShell.exe")) == "new", "files not installed");
                Assert(committed && shortcut, "commit/shortcut missing");
                Assert(updates.Values.Last().Percent == 100, "success not complete");
                Assert(updates.Values.Any(value => value.Percent >= 5 && value.Percent < 85 && value.Detail.Contains("MB")), "no byte progress within extraction");
                Assert(updates.Values.Zip(updates.Values.Skip(1), (a, b) => a.Percent <= b.Percent).All(value => value), "progress went backwards");
                Assert(updates.Values.First(value => value.Percent == 98).Stage.Contains("开始菜单"), "shortcut stage missing");
            } else Assert(!updates.Values.Any(value => value.Percent == 100), "failure declared success");
            if (new[] { "cancel", "cancel-at-commit", "rollback", "prepare-failure", "locked" }.Contains(scenario)) Assert(File.ReadAllText(Path.Combine(destination, "LinkShell.exe")) == "old", "old install changed");
            if (scenario.StartsWith("cancel")) Assert(!committed && !shortcut && calls.Count == 0, "cancellation affected host");
            if (scenario == "update") Assert(String.Join(",", calls) == "prepare-update,recover-update" && Directory.GetDirectories(parent, "*.previous-*").Length == 0, "update recovery missing or old bundle kept");
            if (scenario == "cleanup") {
                Assert(stale.All(name => !Directory.Exists(Path.Combine(parent, name))), "old previous/failed bundles kept");
                Assert(unrelated.All(name => File.Exists(Path.Combine(parent, name, "keep.txt"))), "unrelated directory removed");
                Assert(updates.Values.Any(value => value.Percent == 96 && value.Stage.Contains("旧版本")), "cleanup stage missing");
            }
            if (scenario == "rollback") Assert(stale.Concat(unrelated).All(name => Directory.Exists(Path.Combine(parent, name))) && Directory.GetDirectories(parent, "LinkShell.failed-*").Length == 2, "failed update removed recovery copies");
            if (scenario == "rollback") Assert(String.Join(",", calls) == "prepare-update,recover-update,stop-update-host,recover-update", "rollback order wrong");
            if (scenario == "prepare-failure") Assert(String.Join(",", calls) == "prepare-update,recover-update", "old host not recovered after stop failure");
            if (scenario == "traversal") Assert(!File.Exists(Path.Combine(Path.GetDirectoryName(destination), "escaped.txt")), "escaped staging root");
            if (scenario == "foreign") Assert(File.ReadAllText(Path.Combine(destination, "keep.txt")) == "keep", "foreign data changed");
            if (scenario == "long-path") Assert(File.ReadAllText(Directory.GetFiles(@"\\?\" + destination, "module.js", SearchOption.AllDirectories).Single()) == "long", "long path not installed");
            if (scenario == "shortcut-real") AssertShortcut(Path.Combine(root, "shortcuts"), destination, null);
            Console.WriteLine("PASS " + scenario); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
