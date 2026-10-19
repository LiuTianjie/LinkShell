using System;
using System.Drawing;
using System.Windows.Forms;

namespace LinkShell.Windows {
    // A harmless development-only receiver for end-to-end viewer input checks.
    internal static class InputProbe {
        [STAThread] static void Main() {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var form = new Form { Text = "LinkShell Input QA", StartPosition = FormStartPosition.CenterScreen };
            form.SuspendLayout();
            form.ClientSize = new Size(760, 600);
            form.Font = new Font("Microsoft YaHei UI", 12);
            var text = new TextBox { Left = 30, Top = 65, Width = 680, Height = 90, Multiline = true, AccessibleName = "Remote text" };
            var status = new Label { Left = 30, Top = 210, Width = 680, Height = 70, Text = "Clicks: 0; Wheel: 0; Key: none", AccessibleName = "Input results" };
            var button = new Button { Left = 30, Top = 165, Width = 200, Height = 40, Text = "Test click" };
            var list = new ListBox { Left = 30, Top = 290, Width = 680, Height = 260, AccessibleName = "Scroll test" };
            for (int i = 0; i < 100; i++) list.Items.Add("Scroll row " + i);
            int clicks = 0, wheel = 0;
            string key = "none";
            Action report = () => status.Text = "Clicks: " + clicks + "; Wheel: " + wheel + "; Key: " + key;
            button.Click += (s, e) => { clicks++; report(); };
            text.KeyDown += (s, e) => { key = e.KeyData.ToString(); report(); };
            list.MouseWheel += (s, e) => { wheel += e.Delta; report(); };
            form.Controls.Add(new Label { Left = 30, Top = 20, Width = 680, Height = 35, Text = "Isolated remote input test" });
            form.Controls.AddRange(new Control[] { text, button, status, list });
            form.AutoScaleDimensions = new SizeF(96, 96);
            form.AutoScaleMode = AutoScaleMode.Dpi;
            form.ResumeLayout(true);
            Application.Run(form);
        }
    }
}
