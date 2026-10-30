using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using LinkShell.Windows;

internal static class InstallerUpdateTests {
    static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    static void Throws<T>(Action action) where T : Exception { try { action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
    static string[] Args(string target, string home, string ready, int pid) { return new[] { "--update", "--wait-pid", pid.ToString(), "--target", target, "--home", home, "--ready", ready }; }

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
        if (args.Length == 1 && args[0] == "--child") { Thread.Sleep(8000); return 0; }
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
                using (var child = Process.Start(new ProcessStartInfo(Path.Combine(target, "LinkShell.exe"), "--child") { UseShellExecute = false })) {
                    try {
                        using (var update = InstallerUpdate.Parse(Args(target, home, ready, child.Id))) {
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
                    } finally { if (!child.HasExited) { child.Kill(); child.WaitForExit(); } }
                }
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
