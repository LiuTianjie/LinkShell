using System;
using System.IO;
using System.Reflection;
using System.Windows;
using LinkShell.Windows;

// Runs the real extractor in the build directory; never touches the user's install or shortcuts.
internal static class InstallerVisual {
    [STAThread] static void Main() {
        string build = AppDomain.CurrentDomain.BaseDirectory;
        string root = Path.Combine(build, "install-qa-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        File.WriteAllText(Path.Combine(build, "installer-qa-root.txt"), root);
        var engine = new InstallerEngine(Path.Combine(root, "LinkShell"),
            () => Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"),
            (path, action) => { throw new InvalidOperationException("Isolated fresh install must not change a host."); },
            path => File.WriteAllText(Path.Combine(root, "shortcut-target.txt"), Path.Combine(path, "LinkShell.exe")),
            path => {});
        var window = new InstallerWindow(engine) { Title = "LinkShell 安装 · 隔离验证" };
        window.Loaded += async (s, e) => await window.BeginInstall();
        new Application().Run(window);
    }
}
