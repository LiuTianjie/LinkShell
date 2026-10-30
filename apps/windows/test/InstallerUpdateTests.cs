using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using LinkShell.Windows;

internal static class InstallerUpdateTests {
    static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    static void Throws<T>(Action action) where T : Exception { try { action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
    static string[] Args(string target, string home, string ready, int pid) { return new[] { "--update", "--wait-pid", pid.ToString(), "--target", target, "--home", home, "--ready", ready }; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern uint GetShortPathNameW(string path, StringBuilder result, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern uint GetLongPathNameW(string path, StringBuilder result, uint length);

    static string Spelling(string path, bool shortName) {
        var buffer = new StringBuilder(512);
        uint size = shortName ? GetShortPathNameW(path, buffer, (uint)buffer.Capacity) : GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
        if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (size >= buffer.Capacity) {
            buffer = new StringBuilder((int)size + 1);
            size = shortName ? GetShortPathNameW(path, buffer, (uint)buffer.Capacity) : GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
            if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            Assert(size < buffer.Capacity, "path spelling changed while reading");
        }
        return buffer.ToString();
    }

    static string LoadedImagePath(Process child) {
        var elapsed = Stopwatch.StartNew();
        while (true) {
            Assert(!child.HasExited, "desktop fixture exited before its image path was readable");
            child.Refresh();
            string path = null;
            try {
                var module = child.MainModule;
                if (module != null) path = module.FileName;
            } catch (NullReferenceException) {
                // .NET Framework can return a ProcessModule whose metadata is not filled yet.
                // Only this observed getter race is retried; the assertions remain outside it.
            }
            if (!String.IsNullOrEmpty(path)) return path;
            if (elapsed.ElapsedMilliseconds >= 2000) throw new TimeoutException("desktop fixture image path did not become readable");
            Thread.Sleep(10);
        }
    }

    static void Handoff(string target, string home, string ready, string childExecutable, bool expectDifferentPath = false) {
        string started = Path.Combine(Path.GetDirectoryName(childExecutable), "child-ready-" + Guid.NewGuid().ToString("N"));
        using (var child = Process.Start(new ProcessStartInfo(childExecutable, "--child \"" + started + "\"") { UseShellExecute = false })) {
            try {
                // Process.Start returns before the CLR and module list are ready. A child-owned
                // marker proves this fixture reached Main before we inspect its actual image spelling.
                var startup = Stopwatch.StartNew();
                bool childReady = false;
                while (!childReady) {
                    Assert(!child.HasExited, "desktop fixture exited before its startup handshake");
                    try { childReady = File.Exists(started) && File.ReadAllText(started) == child.Id.ToString(); }
                    catch (IOException) { }
                    if (childReady) break;
                    if (startup.ElapsedMilliseconds >= 10000) throw new TimeoutException("desktop fixture startup handshake timed out");
                    Thread.Sleep(10);
                }
                if (expectDifferentPath) Assert(!String.Equals(LoadedImagePath(child), Path.Combine(target, "LinkShell.exe"), StringComparison.OrdinalIgnoreCase), "short/long fixture did not launch the long process path");
                using (var update = InstallerUpdate.Parse(Args(target, home, ready, child.Id))) {
                    Assert(update.Target == target && update.Home == home && update.Ready == ready, "handoff changed the original path spelling");
                    update.AnnounceReady();
                    Assert(File.ReadAllText(ready) == Process.GetCurrentProcess().Id.ToString(), "ready did not identify installer");
                    Assert(!child.HasExited, "handoff killed the desktop");
                    using (var cancellation = new CancellationTokenSource()) {
                        cancellation.CancelAfter(100);
                        Throws<OperationCanceledException>(() => update.WaitForDesktopExit(cancellation.Token));
                    }
                    Assert(!child.HasExited, "cancel killed the desktop");
                    child.Kill(); child.WaitForExit();
                    update.WaitForDesktopExit(CancellationToken.None);
                }
                Throws<ArgumentException>(() => InstallerUpdate.Parse(Args(target, home, ready, Int32.MaxValue)));
            } finally {
                if (!child.HasExited) { child.Kill(); child.WaitForExit(); }
                if (File.Exists(started)) File.Delete(started);
            }
        }
    }

    static void Junction(string link, string destination) {
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe", "/d /v:off /c mklink /J \"%LINKSHELL_TEST_JUNCTION_LINK%\" \"%LINKSHELL_TEST_JUNCTION_TARGET%\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.EnvironmentVariables["LINKSHELL_TEST_JUNCTION_LINK"] = link;
        start.EnvironmentVariables["LINKSHELL_TEST_JUNCTION_TARGET"] = destination;
        using (var command = Process.Start(start)) {
            var output = command.StandardOutput.ReadToEndAsync(); var errors = command.StandardError.ReadToEndAsync();
            if (!command.WaitForExit(10000)) { command.Kill(); command.WaitForExit(); throw new TimeoutException("mklink timed out"); }
            Assert(command.ExitCode == 0, "mklink failed: " + output.Result + errors.Result);
        }
    }

    static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
        if (args.Length >= 1 && args[0] == "--child") {
            if (args.Length == 2) File.WriteAllText(args[1], Process.GetCurrentProcess().Id.ToString());
            Thread.Sleep(8000); return 0;
        }
        try {
            string scenario = args[0], directory = Path.Combine(args[1], scenario), target = Path.Combine(directory, "App"), home = Path.Combine(directory, "Data");
            string executable = Assembly.GetExecutingAssembly().Location, ready = Path.Combine(Path.GetDirectoryName(executable), "ready");
            if (File.Exists(ready)) File.Delete(ready);
            Directory.CreateDirectory(directory);
            foreach (string file in new[] { "LinkShell.exe", "resources/app/package.json", "LinkShell.Screen.exe", "standalone.json", "runtime/node.exe", "runtime/cli/dist/cli/src/index.js" }) {
                string path = Path.Combine(target, file); Directory.CreateDirectory(Path.GetDirectoryName(path));
                if (file == "LinkShell.exe") File.Copy(executable, path, true); else File.WriteAllText(path, "fixture");
            }
            if (scenario == "parameters") {
                Assert(InstallerUpdate.Parse(new string[0]) == null, "manual install changed");
                Throws<ArgumentException>(() => InstallerUpdate.Parse(new[] { "--update" }));
                Throws<ArgumentException>(() => InstallerUpdate.Parse(Args("C:relative", home, ready, Int32.MaxValue)));
                Throws<ArgumentException>(() => InstallerUpdate.Parse(Args(target, @"\state", ready, Int32.MaxValue)));
                Throws<ArgumentException>(() => InstallerUpdate.Parse(Args(target, target, ready, Int32.MaxValue)));
                Throws<ArgumentException>(() => InstallerUpdate.Parse(Args(target, home, Path.Combine(directory, "ready"), Int32.MaxValue)));
                using (var update = InstallerUpdate.Parse(Args(target, Path.GetPathRoot(home), ready, Int32.MaxValue))) Assert(update.Home == Path.GetPathRoot(home), "drive root home was truncated");
                File.Delete(Path.Combine(target, "standalone.json"));
                Throws<IOException>(() => InstallerUpdate.Parse(Args(target, home, ready, Int32.MaxValue)));
            } else if (scenario == "handoff") {
                Handoff(target, home, ready, Path.Combine(target, "LinkShell.exe"));
            } else if (scenario == "short-path-handoff") {
                Directory.CreateDirectory(home);
                string shortTarget = Spelling(target, true), shortHome = Spelling(home, true), longTarget = Spelling(target, false);
                bool distinct = !String.Equals(shortTarget, longTarget, StringComparison.OrdinalIgnoreCase);
                Console.WriteLine("INFO target short/long aliases differ: " + distinct);
                Handoff(shortTarget, shortHome, ready, Path.Combine(longTarget, "LinkShell.exe"), distinct);
            } else if (scenario == "short-ready-directory") {
                string moduleDirectory = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
                string shortDirectory = Spelling(moduleDirectory, true), longDirectory = Spelling(moduleDirectory, false);
                string otherDirectory = String.Equals(moduleDirectory, shortDirectory, StringComparison.OrdinalIgnoreCase) ? longDirectory : shortDirectory;
                string alternateReady = Path.Combine(otherDirectory, "ready");
                Console.WriteLine("INFO ready/main-module directory spellings differ: " + !String.Equals(moduleDirectory, otherDirectory, StringComparison.OrdinalIgnoreCase));
                Handoff(target, home, alternateReady, Path.Combine(Spelling(target, false), "LinkShell.exe"));
                Assert(File.Exists(ready), "ready was not created in the installer directory");
            } else if (scenario == "missing-home") {
                string missing = Path.Combine(home, "nested", "new-data");
                using (var update = InstallerUpdate.Parse(Args(target, missing, ready, Int32.MaxValue))) {
                    update.ValidatePaths();
                    Assert(update.Home == missing && !Directory.Exists(home), "missing external home was created or changed");
                }
            } else if (scenario.StartsWith("junction-")) {
                string link = Path.Combine(directory, "Linked"), data = Path.Combine(target, "data");
                Directory.CreateDirectory(data);
                File.WriteAllText(Path.Combine(data, "keep.txt"), "preserved");
                string aliasTarget = target, aliasHome = link;
                bool allowed = scenario == "junction-external" || scenario == "junction-external-missing", dangling = scenario == "junction-dangling";
                string secondLink = null;
                if (scenario == "junction-home") Junction(link, data);
                else if (scenario == "junction-ancestor") { Junction(link, target); aliasHome = Path.Combine(link, "missing", "new-data"); }
                else if (scenario == "junction-target-ancestor") { Junction(link, directory); aliasTarget = Path.Combine(link, "App"); aliasHome = data; }
                else if (scenario == "junction-both-aliases") {
                    Junction(link, directory); aliasTarget = Path.Combine(link, "App");
                    secondLink = Path.Combine(directory, "LinkedHome"); Junction(secondLink, data); aliasHome = secondLink;
                }
                else if (allowed || dangling) {
                    string external = Path.Combine(directory, "ExternalData"); Directory.CreateDirectory(external); Junction(link, external);
                    if (dangling) { Directory.Delete(external); aliasHome = Path.Combine(link, "new-data"); }
                    else if (scenario == "junction-external-missing") aliasHome = Path.Combine(link, "missing", "new-data");
                } else throw new Exception("Unknown junction scenario");
                try {
                    if (allowed) {
                        using (var update = InstallerUpdate.Parse(Args(aliasTarget, aliasHome, ready, Int32.MaxValue))) {
                            Assert(update.Target == aliasTarget && update.Home == aliasHome, "resolved paths changed installation semantics");
                        }
                    } else if (dangling) Throws<IOException>(() => InstallerUpdate.Parse(Args(aliasTarget, aliasHome, ready, Int32.MaxValue)));
                    else Throws<ArgumentException>(() => InstallerUpdate.Parse(Args(aliasTarget, aliasHome, ready, Int32.MaxValue)));
                    Assert(!File.Exists(ready), "path rejection announced handoff");
                    Assert(File.ReadAllText(Path.Combine(data, "keep.txt")) == "preserved", "junction guard modified data");
                } finally { if (secondLink != null) Directory.Delete(secondLink); Directory.Delete(link); }
            } else if (scenario == "foreign-parent") {
                using (var child = Process.Start(new ProcessStartInfo(executable, "--child") { UseShellExecute = false })) {
                    try { Throws<ArgumentException>(() => InstallerUpdate.Parse(Args(target, home, ready, child.Id))); }
                    finally { if (!child.HasExited) { child.Kill(); child.WaitForExit(); } }
                }
                Assert(!File.Exists(ready), "rejected handoff announced ready");
            } else throw new Exception("Unknown scenario");
            if (File.Exists(ready)) File.Delete(ready);
            Console.WriteLine("PASS " + scenario); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
