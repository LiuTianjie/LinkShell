using System;
using System.IO;
using System.Windows;

namespace LinkShell.Windows {
    // A development-only launcher for visual QA. It never opens the user's LinkShell state.
    internal static class SmokeDesktop {
        [STAThread] internal static void Main(string[] args) {
            bool preview = Array.IndexOf(args, "--preview") >= 0;
            string build = AppDomain.CurrentDomain.BaseDirectory;
            string root = Path.GetFullPath(Path.Combine(build, "..", "..", ".."));
            string home = Path.Combine(build, "qa-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(home);
            Directory.CreateDirectory(Path.Combine(home, "codex"));
            Directory.CreateDirectory(Path.Combine(home, "claude"));
            Environment.SetEnvironmentVariable("LINKSHELL_HOME", home);
            Environment.SetEnvironmentVariable("CODEX_HOME", Path.Combine(home, "codex"));
            Environment.SetEnvironmentVariable("CLAUDE_CONFIG_DIR", Path.Combine(home, "claude"));
            Environment.SetEnvironmentVariable("LINKSHELL_GATEWAY", "off");
            Environment.SetEnvironmentVariable("LINKSHELL_DESKTOP_NODE", File.ReadAllText(Path.Combine(build, "node-path.txt")).Trim());
            Environment.SetEnvironmentVariable("LINKSHELL_DESKTOP_CLI", Path.Combine(root, "packages", "cli", "dist", "cli", "src", "index.js"));
            Environment.SetEnvironmentVariable("LINKSHELL_DESKTOP_WEB", Path.Combine(root, "apps", "web", "dist"));
            File.WriteAllText(Path.Combine(build, preview ? "preview-home.txt" : "qa-home.txt"), home);
            new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown }.Run(new Dashboard(false, preview));
        }
    }
    internal static class PreviewDesktop {
        [STAThread] static void Main() { SmokeDesktop.Main(new[] { "--preview" }); }
    }
}
