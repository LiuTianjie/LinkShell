using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Threading;
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

    static int Main(string[] args) {
        try {
            string scenario = args[0], root = Path.GetFullPath(args[1]), destination = Path.Combine(root, scenario, "LinkShell");
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            var updates = new Updates(); var token = new CancellationTokenSource(); var calls = new List<string>(); bool committed = false, shortcut = false;
            Func<Stream> payload = () => Payload();
            Action<string, string> cli = (path, action) => { calls.Add(action); };
            Action<string> link = path => { shortcut = true; Assert(File.Exists(Path.Combine(path, "LinkShell.exe")), "shortcut before files"); };
            Action<string> running = path => {};
            Action commit = () => { token.Token.ThrowIfCancellationRequested(); committed = true; };
            if (new[] { "cancel", "cancel-at-commit", "update", "rollback", "prepare-failure", "locked", "transient-lock" }.Contains(scenario)) Old(destination);
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
            if (new[] { "fresh", "update", "transient-lock", "long-path", "shortcut-real" }.Contains(scenario)) {
                Assert(File.ReadAllText(Path.Combine(destination, "LinkShell.exe")) == "new", "files not installed");
                Assert(committed && shortcut, "commit/shortcut missing");
                Assert(updates.Values.Last().Percent == 100, "success not complete");
                Assert(updates.Values.Any(value => value.Percent >= 5 && value.Percent < 85 && value.Detail.Contains("MB")), "no byte progress within extraction");
                Assert(updates.Values.Zip(updates.Values.Skip(1), (a, b) => a.Percent <= b.Percent).All(value => value), "progress went backwards");
                Assert(updates.Values.First(value => value.Percent == 98).Stage.Contains("开始菜单"), "shortcut stage missing");
            } else Assert(!updates.Values.Any(value => value.Percent == 100), "failure declared success");
            if (new[] { "cancel", "cancel-at-commit", "rollback", "prepare-failure", "locked" }.Contains(scenario)) Assert(File.ReadAllText(Path.Combine(destination, "LinkShell.exe")) == "old", "old install changed");
            if (scenario.StartsWith("cancel")) Assert(!committed && !shortcut && calls.Count == 0, "cancellation affected host");
            if (scenario == "update") Assert(String.Join(",", calls) == "prepare-update,recover-update" && Directory.GetDirectories(Path.GetDirectoryName(destination), "*.previous-*").Length == 1, "update recovery/backup missing");
            if (scenario == "rollback") Assert(String.Join(",", calls) == "prepare-update,recover-update,stop-update-host,recover-update", "rollback order wrong");
            if (scenario == "prepare-failure") Assert(String.Join(",", calls) == "prepare-update,recover-update", "old host not recovered after stop failure");
            if (scenario == "traversal") Assert(!File.Exists(Path.Combine(Path.GetDirectoryName(destination), "escaped.txt")), "escaped staging root");
            if (scenario == "foreign") Assert(File.ReadAllText(Path.Combine(destination, "keep.txt")) == "keep", "foreign data changed");
            if (scenario == "long-path") Assert(File.ReadAllText(Directory.GetFiles(@"\\?\" + destination, "module.js", SearchOption.AllDirectories).Single()) == "long", "long path not installed");
            if (scenario == "shortcut-real") Assert(new FileInfo(Path.Combine(root, "shortcuts", "LinkShell.lnk")).Length > 0, "native shortcut missing");
            Console.WriteLine("PASS " + scenario); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
