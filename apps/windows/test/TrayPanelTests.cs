using System;
using System.ComponentModel;
using System.Reflection;
using System.Windows;

namespace LinkShell.Windows {
    internal static class TrayPanelTests {
        static void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
        static void Deactivate(Window panel) {
            typeof(Window).GetMethod("OnDeactivated", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(panel, new object[] { EventArgs.Empty });
        }
        [STAThread] static void Main() {
            try {
                // WPF can deliver Deactivated before Closed. Reproduce that order without
                // showing test windows or stealing focus from the user's desktop.
                for (int i = 0; i < 30; i++) {
                    var panel = new TrayPanel(); int closing = 0, closed = 0;
                    panel.Closing += (s, e) => { closing++; Deactivate(panel); panel.Dismiss(); };
                    panel.Closed += (s, e) => { closed++; panel.Dismiss(); };
                    if (i % 3 == 0) panel.Dismiss();
                    else if (i % 3 == 1) panel.Close();
                    else Deactivate(panel);
                    panel.Dismiss();
                    Check(closing == 1 && closed == 1, "one close per tray panel");
                }
                var cancelled = new TrayPanel(); int attempts = 0, completed = 0;
                cancelled.Closing += (s, e) => { attempts++; if (attempts == 1) e.Cancel = true; };
                cancelled.Closed += (s, e) => completed++;
                cancelled.Dismiss(); cancelled.Dismiss();
                Check(attempts == 2 && completed == 1, "cancelled close can be retried");
                Console.WriteLine("PASS tray dismissal: deactivation during close, repeated dismiss, native close and cancellation");
            } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        }
    }
}
