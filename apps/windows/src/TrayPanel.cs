using System;
using System.ComponentModel;
using System.Windows;

namespace LinkShell.Windows {
    internal sealed class TrayPanel : Window {
        bool closing;

        public void Dismiss() { if (!closing) Close(); }

        protected override void OnClosing(CancelEventArgs e) {
            // Closing can synchronously deactivate the HWND before Closed fires.
            // WPF rejects a second Close while the first one is still in progress.
            closing = true;
            base.OnClosing(e);
            if (e.Cancel) closing = false;
        }

        protected override void OnDeactivated(EventArgs e) {
            base.OnDeactivated(e);
            Dismiss();
        }
    }
}
