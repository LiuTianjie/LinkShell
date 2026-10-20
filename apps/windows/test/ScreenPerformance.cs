using System;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;

namespace LinkShell.Windows {
    // Repeatable moving text and shapes for comparing native capture paths.
    internal sealed class ScreenPerformance : Form {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        readonly Timer timer = new Timer { Interval = 16 };
        readonly Font code = new Font("Consolas", 13);
        readonly Font heading = new Font("Microsoft YaHei UI", 17, FontStyle.Bold);
        bool moving = true;
        int phase;
        public ScreenPerformance() {
            Text = "LinkShell 屏幕性能测试";
            ClientSize = new Size(1300, 820); StartPosition = FormStartPosition.CenterScreen;
            DoubleBuffered = true; BackColor = Color.FromArgb(20, 24, 31);
            var toggle = new Button { Text = "暂停动画", Left = 1080, Top = 24, Width = 170, Height = 46 };
            toggle.Click += (s, e) => { moving = !moving; toggle.Text = moving ? "暂停动画" : "开始动画"; Invalidate(); };
            Controls.Add(toggle);
            timer.Tick += (s, e) => { if (moving) { phase = (phase + 5) % 10000; Invalidate(); } };
            timer.Start();
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            e.Graphics.DrawString("LinkShell · Windows 屏幕共享性能验证", heading, Brushes.White, 28, 25);
            e.Graphics.DrawString("中文文字 · Drag / Scroll · 0123456789 · {} [] =>", code, Brushes.LightGray, 28, 75);
            var textArea = new Rectangle(28, 130, ClientSize.Width - 56, ClientSize.Height - 160);
            e.Graphics.SetClip(textArea);
            for (int i = -1; i < 40; i++) {
                int y = 135 + i * 24 - phase % 24;
                e.Graphics.DrawString((i + 40 + phase / 24).ToString("D4") + "   const frame = await captureDesktop({ width: 1920, fps: 30 });  // 平滑滚动测试", code, i % 3 == 0 ? Brushes.Aquamarine : Brushes.LightSteelBlue, 35, y);
            }
            e.Graphics.FillRectangle(Brushes.MediumSlateBlue, 40 + phase % Math.Max(1, ClientSize.Width - 210), ClientSize.Height - 110, 130, 45);
        }
        protected override void Dispose(bool disposing) {
            if (disposing) { timer.Dispose(); code.Dispose(); heading.Dispose(); }
            base.Dispose(disposing);
        }
        [STAThread] static void Main() {
            SetProcessDPIAware(); Application.EnableVisualStyles(); Application.Run(new ScreenPerformance());
        }
    }
}
