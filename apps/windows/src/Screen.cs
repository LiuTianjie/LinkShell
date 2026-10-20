using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace LinkShell.Windows {
    // This process has no listener. The authenticated host owns its stdin/stdout lifetime.
    internal static partial class ScreenHelper {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static readonly object OutputLock = new object();
        static volatile bool ended;
        static bool dryRun;
        static Rectangle bounds;
        static readonly HashSet<ushort> HeldKeys = new HashSet<ushort>();
        static bool leftDown, rightDown;
        static IntPtr desktop;
        static readonly AutoResetEvent CaptureWake = new AutoResetEvent(false);
        sealed class CaptureProfile {
            public int Width, Fps, Quality;
            public CaptureProfile(int width, int fps, int quality) {
                Width = Math.Max(320, Math.Min(3840, width));
                Fps = Math.Max(1, Math.Min(30, fps));
                Quality = Math.Max(35, Math.Min(92, quality));
            }
        }
        static volatile CaptureProfile captureProfile;
        static volatile bool capturePaused;
        static int forceFrame = 1;

        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] input, int size);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll", SetLastError = true)] static extern bool StretchBlt(IntPtr dest, int x, int y, int w, int h, IntPtr source, int sx, int sy, int sw, int sh, uint operation);
        [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc, int mode);
        [DllImport("gdi32.dll")] static extern bool SetBrushOrgEx(IntPtr dc, int x, int y, IntPtr previous);
        [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)] static extern int memcmp(byte[] left, byte[] right, UIntPtr size);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScan(char key);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr handle);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
        [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {
            [FieldOffset(0)] public MOUSEINPUT mouse;
            [FieldOffset(0)] public KEYBDINPUT key;
        }
        [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }

        [STAThread] static int Main(string[] args) {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            dryRun = args.Contains("--dry-run");
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
            try {
                // Helpers launched by background consoles may inherit a non-input desktop.
                // Never switch the user's desktop or attach to Winlogon/UAC.
                if (!dryRun) {
                    desktop = OpenInputDesktop(0, false, 0x0001 | 0x0080);
                    if (desktop == IntPtr.Zero) throw new InvalidOperationException("无法访问当前 Windows 桌面：" + Marshal.GetLastWin32Error());
                    string inputName = DesktopName(desktop), ownName = DesktopName(GetThreadDesktop(GetCurrentThreadId()));
                    if (!String.Equals(inputName, "Default", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("请解锁 Windows 并关闭 UAC 提示后重试屏幕连接（" + inputName + "）");
                    if (ownName != inputName && !SetThreadDesktop(desktop)) throw new InvalidOperationException("无法连接 Windows 输入桌面：" + Marshal.GetLastWin32Error());
                }
                if (args.Length == 1 && args[0] == "--displays") {
                    EnsureDesktop();
                    Write(Screen.AllScreens.Select((s, i) => new { screen = i, name = s.Primary ? "主屏幕" : "屏幕 " + (i + 1), w = s.Bounds.Width, h = s.Bounds.Height, main = s.Primary }).ToArray());
                    return 0;
                }
                if ((args.Length == 4 || args.Length == 5) && args[0] == "--capture") {
                    Capture(Int32.Parse(args[1]), Int32.Parse(args[2]), Int32.Parse(args[3]), args.Length == 5 ? Int32.Parse(args[4]) : 75);
                    return 0;
                }
                if (args.Length == 6 && args[0] == "--video") {
                    CaptureVideo(Int32.Parse(args[1]), Int32.Parse(args[2]), Int32.Parse(args[3]), Int32.Parse(args[4]), args[5]);
                    return 0;
                }
                if (args.Length >= 1) {
                    bounds = Display(Int32.Parse(args[0]));
                    dryRun = args.Contains("--dry-run");
                    Control();
                    return 0;
                }
                throw new ArgumentException("Expected --displays, --capture <display> <width> <fps>, or <display> [--dry-run]");
            } catch (Exception error) {
                Console.Error.WriteLine(error.Message);
                return 1;
            } finally { Release(); if (desktop != IntPtr.Zero) CloseDesktop(desktop); }
        }

        static string DesktopName(IntPtr handle) {
            int needed; var name = new StringBuilder(256);
            return GetUserObjectInformation(handle, 2, name, name.Capacity * 2, out needed) ? name.ToString() : "";
        }

        static void EnsureDesktop() {
            var home = Environment.GetEnvironmentVariable("LINKSHELL_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".linkshell");
            if (File.Exists(Path.Combine(home, "windows-screen-disabled"))) throw new InvalidOperationException("请在 LinkShell 桌面版设置中允许远程屏幕");
            if (!Environment.UserInteractive) throw new InvalidOperationException("屏幕共享需要登录 Windows 桌面");
            if (dryRun) return;
            var current = OpenInputDesktop(0, false, 0x0001);
            try { if (current == IntPtr.Zero || DesktopName(current) != "Default") throw new InvalidOperationException("Windows 已锁定或正在显示安全桌面，请在电脑上解锁后重新连接"); }
            finally { if (current != IntPtr.Zero) CloseDesktop(current); }
        }
        static Rectangle Display(int index) {
            EnsureDesktop();
            var all = Screen.AllScreens;
            if (index < 0 || index >= all.Length) throw new ArgumentOutOfRangeException("display", "屏幕已断开，请重新打开屏幕共享");
            return all[index].Bounds;
        }
        static void Write(object value) { lock (OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }

        static void Capture(int screen, int width, int fps, int quality) {
            bounds = Display(screen);
            captureProfile = new CaptureProfile(width, fps, quality);
            // EOF also stops capture after a host crash; nothing keeps recording without a reader.
            var eof = new Thread(() => {
                try {
                    string line;
                    while ((line = Console.ReadLine()) != null) {
                        if (line.Length > 1024) continue;
                        try {
                            var message = Json.Deserialize<Dictionary<string, object>>(line);
                            string type = Str(message, "t");
                            if (type == "profile") captureProfile = new CaptureProfile((int)Number(message, "width"), (int)Number(message, "fps"), (int)Number(message, "quality"));
                            else if (type == "pause") capturePaused = Number(message, "value") != 0;
                            else if (type != "keyframe") continue;
                            Interlocked.Exchange(ref forceFrame, 1);
                            CaptureWake.Set();
                        } catch { /* Malformed control data must not end a valid capture. */ }
                    }
                } finally { ended = true; CaptureWake.Set(); }
            }) { IsBackground = true };
            eof.Start();
            var codec = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
            var clock = Stopwatch.StartNew();
            bool diagnostics = Environment.GetEnvironmentVariable("LINKSHELL_SCREEN_DIAGNOSTICS") == "1";
            long metricAt = 0, copyMs = 0, compareMs = 0, encodeMs = 0, writeMs = 0;
            int measured = 0;
            long checkedAt = -1000;
            IntPtr screenDC = GetDC(IntPtr.Zero);
            if (screenDC == IntPtr.Zero) throw new InvalidOperationException("无法读取 Windows 桌面");
            string duplicationReason;
            var duplication = DesktopDuplication.TryCreate(bounds, out duplicationReason);
            Console.Error.WriteLine(duplication == null ? "[capture] GDI: " + duplicationReason : "[capture] DXGI Desktop Duplication");
            try {
                using (var output = Console.OpenStandardOutput())
                using (var frame = new MemoryStream(256 * 1024)) {
                    while (!ended) {
                        var profile = captureProfile;
                        int w = Math.Min(profile.Width, bounds.Width), h = Math.Max(1, (int)((long)bounds.Height * w / bounds.Width));
                        using (var scaled = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                        using (var target = Graphics.FromImage(scaled)) {
                            byte[] previous = null, pixels = null;
                            long lastChanged = clock.ElapsedMilliseconds, lastSent = -2000;
                            bool refined = false;
                            int encodedQuality = 0;
                            while (!ended && profile == captureProfile) {
                                long began = clock.ElapsedMilliseconds;
                                if (began - checkedAt >= 250) {
                                    if (Display(screen) != bounds) throw new InvalidOperationException("屏幕布局已改变，请重新连接");
                                    checkedAt = began;
                                }
                                if (capturePaused) { CaptureWake.WaitOne(100); continue; }
                                // Scale while copying from the desktop DC, avoiding a full-resolution bitmap
                                // and the second, CPU-resampled GDI+ copy on every frame.
                                bool copied = false;
                                if (duplication != null) {
                                    try { copied = duplication.CopyTo(target, w, h, frame.Length == 0); }
                                    catch (Exception error) { Console.Error.WriteLine("[capture] GDI fallback: " + error.Message); duplication.Dispose(); duplication = null; }
                                }
                                if (duplication == null) {
                                    var dc = target.GetHdc();
                                    try {
                                        SetStretchBltMode(dc, 3); SetBrushOrgEx(dc, 0, 0, IntPtr.Zero);
                                        if (!StretchBlt(dc, 0, 0, w, h, screenDC, bounds.Left, bounds.Top, bounds.Width, bounds.Height, 0x40cc0020)) throw new InvalidOperationException("Windows 屏幕采集失败：" + Marshal.GetLastWin32Error());
                                        copied = true;
                                    } finally { target.ReleaseHdc(dc); }
                                }
                                if (!copied && frame.Length == 0) { CaptureWake.WaitOne(10); continue; }
                                long copiedAt = clock.ElapsedMilliseconds;
                                var locked = scaled.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                                try {
                                    int size = checked(Math.Abs(locked.Stride) * h);
                                    if (pixels == null) { pixels = new byte[size]; previous = new byte[size]; }
                                    Marshal.Copy(locked.Scan0, pixels, 0, size);
                                } finally { scaled.UnlockBits(locked); }
                                bool changed = frame.Length == 0 || memcmp(pixels, previous, (UIntPtr)pixels.Length) != 0;
                                if (changed) { Buffer.BlockCopy(pixels, 0, previous, 0, pixels.Length); lastChanged = began; refined = false; }
                                bool refine = !refined && began - lastChanged >= 250;
                                bool forced = Interlocked.Exchange(ref forceFrame, 0) != 0;
                                long comparedAt = clock.ElapsedMilliseconds, encodedAt = comparedAt;
                                if (changed || refine || forced || began - lastSent >= 2000) {
                                    int nextQuality = refine || refined ? Math.Min(92, profile.Quality + 15) : profile.Quality;
                                    if (changed || encodedQuality != nextQuality || frame.Length == 0) {
                                        frame.SetLength(0);
                                        using (var parameters = new EncoderParameters(1)) {
                                            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)nextQuality);
                                            scaled.Save(frame, codec, parameters);
                                        }
                                        encodedQuality = nextQuality;
                                    }
                                    encodedAt = clock.ElapsedMilliseconds;
                                    var size = BitConverter.GetBytes(checked((int)frame.Length));
                                    output.Write(size, 0, size.Length);
                                    frame.Position = 0;
                                    frame.CopyTo(output);
                                    output.Flush();
                                    lastSent = began;
                                    if (refine) refined = true;
                                }
                                copyMs += copiedAt - began; compareMs += comparedAt - copiedAt; encodeMs += encodedAt - comparedAt; writeMs += clock.ElapsedMilliseconds - encodedAt; measured++;
                                if (diagnostics && clock.ElapsedMilliseconds - metricAt >= 2000) {
                                    Console.Error.WriteLine("[capture] frames=" + measured + " copy=" + copyMs / measured + "ms compare=" + compareMs / measured + "ms encode=" + encodeMs / measured + "ms write=" + writeMs / measured + "ms");
                                    metricAt = clock.ElapsedMilliseconds; copyMs = compareMs = encodeMs = writeMs = measured = 0;
                                }
                                int wait = (int)Math.Ceiling(1000.0 / profile.Fps) - (int)(clock.ElapsedMilliseconds - began);
                                if (wait > 0) CaptureWake.WaitOne(wait);
                            }
                        }
                        // A profile switch must publish its first frame even when the desktop is still.
                        frame.SetLength(0);
                    }
                }
            } finally { if (duplication != null) duplication.Dispose(); ReleaseDC(IntPtr.Zero, screenDC); }
        }

        static void Control() {
            Write(new { t = "ready", trusted = true, app = "LinkShell" });
            var next = Task.Run(() => Console.ReadLine());
            POINT last = new POINT { X = Int32.MinValue, Y = Int32.MinValue };
            for (;;) {
                // Recheck while idle too: disabling sharing or locking the PC releases a held drag.
                EnsureDesktop();
                POINT p;
                if (GetCursorPos(out p) && (p.X != last.X || p.Y != last.Y)) {
                    Write(new { t = "cursor", x = Math.Max(0, Math.Min(1, (p.X - bounds.Left) / (double)bounds.Width)), y = Math.Max(0, Math.Min(1, (p.Y - bounds.Top) / (double)bounds.Height)) });
                    last = p;
                }
                if (!next.Wait(16)) continue;
                var line = next.Result;
                if (line == null) return;
                next = Task.Run(() => Console.ReadLine());
                if (line.Length > 32000) continue;
                var e = Json.Deserialize<Dictionary<string, object>>(line);
                if (dryRun) { e["t"] = "posted"; Write(e); continue; }
                Handle(e);
            }
        }
        static string Str(Dictionary<string, object> e, string key) { object value; return e.TryGetValue(key, out value) ? Convert.ToString(value, CultureInfo.InvariantCulture) : ""; }
        static double Number(Dictionary<string, object> e, string key) { object value; return e.TryGetValue(key, out value) ? Convert.ToDouble(value, CultureInfo.InvariantCulture) : 0; }
        static void Post(INPUT input) {
            if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("Windows 拒绝了输入；无法控制管理员窗口、锁屏或 UAC 安全桌面");
        }
        static void Mouse(uint flags, int x = 0, int y = 0, int data = 0) { Post(new INPUT { type = 0, data = new INPUTUNION { mouse = new MOUSEINPUT { dx = x, dy = y, mouseData = unchecked((uint)data), flags = flags } } }); }
        static void Key(ushort vk, bool up, ushort scan = 0, bool unicode = false) {
            uint extended = (vk >= 0x21 && vk <= 0x2e) || vk == 0x5b ? 1u : 0u;
            Post(new INPUT { type = 1, data = new INPUTUNION { key = new KEYBDINPUT { vk = vk, scan = scan, flags = (up ? 2u : 0u) | (unicode ? 4u : extended) } } });
            if (!unicode) { if (up) HeldKeys.Remove(vk); else HeldKeys.Add(vk); }
        }
        static void Release() {
            if (dryRun) return;
            foreach (ushort key in HeldKeys.ToArray()) { try { Key(key, true); } catch {} }
            try { if (leftDown) Mouse(0x0004); if (rightDown) Mouse(0x0010); } catch {}
            leftDown = rightDown = false;
        }
        static void Handle(Dictionary<string, object> e) {
            string type = Str(e, "t");
            if (type == "move") {
                var all = SystemInformation.VirtualScreen;
                var x = bounds.Left + (int)(Math.Max(0, Math.Min(1, Number(e, "x"))) * (bounds.Width - 1));
                var y = bounds.Top + (int)(Math.Max(0, Math.Min(1, Number(e, "y"))) * (bounds.Height - 1));
                Mouse(0x8000 | 0x4000 | 0x0001, (int)((long)(x - all.Left) * 65535 / Math.Max(1, all.Width - 1)), (int)((long)(y - all.Top) * 65535 / Math.Max(1, all.Height - 1)));
                return;
            }
            var modifiers = new List<ushort>();
            object raw;
            if (e.TryGetValue("m", out raw)) foreach (object m in (System.Collections.IEnumerable)raw) {
                ushort key = (string)m == "cmd" ? (ushort)0x5b : (string)m == "ctrl" ? (ushort)0x11 : (string)m == "alt" ? (ushort)0x12 : (ushort)0x10;
                if (!HeldKeys.Contains(key)) { Key(key, false); modifiers.Add(key); }
            }
            try {
                if (type == "down" || type == "up") {
                    bool down = type == "down", right = Str(e, "b") == "right";
                    Mouse(right ? (down ? 0x0008u : 0x0010u) : (down ? 0x0002u : 0x0004u));
                    if (right) rightDown = down; else leftDown = down;
                } else if (type == "scroll") {
                    int dy = (int)Math.Max(-12000, Math.Min(12000, Number(e, "dy")));
                    int dx = (int)Math.Max(-12000, Math.Min(12000, Number(e, "dx")));
                    // The viewer sends content movement; Windows vertical wheel is positive up,
                    // while its horizontal wheel is positive right.
                    if (dy != 0) Mouse(0x0800, 0, 0, dy);
                    if (dx != 0) Mouse(0x1000, 0, 0, -dx);
                } else if (type == "text") {
                    foreach (char c in Str(e, "s").Take(4000)) { Key(0, false, c, true); Key(0, true, c, true); }
                } else if (type == "key") {
                    string name = Str(e, "k");
                    ushort key = NamedKey(name);
                    if (key == 0 && name.Length == 1) {
                        short mapping = VkKeyScan(name[0]);
                        if (mapping == -1) { Key(0, false, name[0], true); Key(0, true, name[0], true); return; }
                        key = (ushort)(mapping & 255);
                        ushort[] needed = { 0x10, 0x11, 0x12 };
                        for (int i = 0; i < needed.Length; i++) if ((mapping & (1 << (8 + i))) != 0 && !HeldKeys.Contains(needed[i])) { Key(needed[i], false); modifiers.Add(needed[i]); }
                    }
                    if (key != 0) { Key(key, false); Key(key, true); }
                }
            } finally { for (int i = modifiers.Count - 1; i >= 0; i--) Key(modifiers[i], true); }
        }
        static ushort NamedKey(string name) {
            switch (name.ToLowerInvariant()) {
                case "enter": case "return": return 0x0d;
                case "tab": return 0x09; case "escape": case "esc": return 0x1b;
                case "backspace": return 0x08; case "delete": return 0x2e;
                case "arrowleft": case "left": return 0x25; case "arrowup": case "up": return 0x26;
                case "arrowright": case "right": return 0x27; case "arrowdown": case "down": return 0x28;
                case "home": return 0x24; case "end": return 0x23; case "pageup": return 0x21; case "pagedown": return 0x22;
                case "space": return 0x20; case "insert": return 0x2d;
            }
            int fn;
            return name.StartsWith("F", StringComparison.OrdinalIgnoreCase) && Int32.TryParse(name.Substring(1), out fn) && fn >= 1 && fn <= 24 ? (ushort)(0x6f + fn) : (ushort)0;
        }
    }
}
