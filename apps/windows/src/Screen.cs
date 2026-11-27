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
using System.Security.Cryptography;
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
        static readonly AutoResetEvent ShapeWake = new AutoResetEvent(false);
        static readonly Dictionary<string, CursorShapeSnapshot> CursorShapeCache = new Dictionary<string, CursorShapeSnapshot>();
        internal sealed class CursorShapeSnapshot {
            public string Id, Png;
            public double Width, Height, HotX, HotY, Scale;
        }
        sealed class CaptureProfile {
            public int Width, Fps, Quality;
            public CaptureProfile(int width, int fps, int quality) {
                Width = Math.Max(320, Math.Min(3840, width));
                Fps = Math.Max(1, Math.Min(30, fps));
                Quality = Math.Max(35, Math.Min(95, quality));
            }
        }
        static volatile CaptureProfile captureProfile;
        static volatile bool capturePaused;
        static int forceFrame = 1;

        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] input, int size);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
        [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
        [DllImport("user32.dll")] static extern IntPtr CopyIcon(IntPtr icon);
        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
        [DllImport("user32.dll", SetLastError = true)] static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr icon, int width, int height, int step, IntPtr brush, int flags);
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
        delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE displayDevice, uint flags);
        [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr hWnd, IntPtr lprcUpdate, IntPtr hrgnUpdate, uint flags);
        [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint esFlags);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MONITORINFOEX {
            public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct DISPLAY_DEVICE {
            public int cb;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
            public uint StateFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
        }
        internal struct DisplayInfo {
            public Rectangle Bounds;
            public bool Primary;
            public IntPtr Monitor;
            public string DeviceName;
            public bool HasActiveMonitor;
        }
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public POINT ptScreenPos; }
        [StructLayout(LayoutKind.Sequential)] struct ICONINFO { [MarshalAs(UnmanagedType.Bool)] public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }
        [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
        [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {
            [FieldOffset(0)] public MOUSEINPUT mouse;
            [FieldOffset(0)] public KEYBDINPUT key;
        }
        [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }

        [STAThread] static int Main(string[] args) {
            bool isServiceMode = args.Length >= 1 && (args[0] == "--service" || args[0] == "--service-worker");
            if (!isServiceMode) {
                // Services and Session-N detached workers have no console handle; SetConsoleCP throws IOException there.
                try {
                    Console.InputEncoding = new UTF8Encoding(false);
                    Console.OutputEncoding = new UTF8Encoding(false);
                } catch { }
            }
            dryRun = args.Contains("--dry-run");
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
            try {
                // Service management and Session-0 service modes run outside the user's input desktop.
                if (args.Length == 1 && args[0] == "--service") {
                    RunElevatedWindowsService();
                    return 0;
                }
                if (args.Length == 9 && args[0] == "--service-worker") {
                    RunElevatedServiceWorker(args[1], args[2], Int32.Parse(args[3]), Int32.Parse(args[4]), Int32.Parse(args[5]), Int32.Parse(args[6]), Int32.Parse(args[7]), args[8]);
                    return 0;
                }
                if (args.Length >= 2 && args[0] == "--install-service") {
                    string targetHome = args.Length >= 3 ? args[2] : UserHomeDir();
                    try {
                        ClearServiceLastError(targetHome);
                        InstallElevatedService(args[1], targetHome);
                    } catch (Exception err) {
                        WriteServiceLastError(targetHome, err.Message);
                        throw;
                    }
                    return 0;
                }
                if (args.Length >= 1 && args[0] == "--uninstall-service") {
                    string targetHome = args.Length >= 2 ? args[1] : UserHomeDir();
                    try {
                        ClearServiceLastError(targetHome);
                        UninstallElevatedService(targetHome);
                    } catch (Exception err) {
                        WriteServiceLastError(targetHome, err.Message);
                        throw;
                    }
                    return 0;
                }
                if (args.Length == 1 && args[0] == "--service-status") {
                    PrintElevatedServiceStatus();
                    return 0;
                }
                if (args.Length == 1 && args[0] == "--vdd-status") {
                    PrintVddStatus();
                    return 0;
                }
                if (args.Length >= 1 && args[0] == "--install-vdd") {
                    string vddDir = args.Length >= 2 ? args[1] : null;
                    string targetHome = args.Length >= 3 ? args[2] : UserHomeDir();
                    try {
                        ClearServiceLastError(targetHome);
                        InstallVddDriver(vddDir);
                    } catch (Exception err) {
                        WriteServiceLastError(targetHome, err.Message);
                        throw;
                    }
                    return 0;
                }
                if (args.Length >= 1 && args[0] == "--uninstall-vdd") {
                    string targetHome = args.Length >= 2 ? args[1] : UserHomeDir();
                    try {
                        ClearServiceLastError(targetHome);
                        UninstallVddDriver();
                    } catch (Exception err) {
                        WriteServiceLastError(targetHome, err.Message);
                        throw;
                    }
                    return 0;
                }
                if (args.Length >= 1 && (args[0] == "--enable-vdd" || args[0] == "--disable-vdd")) {
                    bool en = args[0] == "--enable-vdd";
                    if (!IsRunningAsAdministrator()) throw new InvalidOperationException("切换虚拟显示器状态需要管理员权限");
                    SetVddNodeEnabled(en);
                    return 0;
                }

                // Helpers launched by background consoles may inherit a non-input desktop.
                // Never switch the user's desktop or attach to Winlogon/UAC unless the elevated service handles it.
                bool serviceAvailable = IsElevatedServiceAvailable();
                if (!dryRun) {
                    desktop = OpenInputDesktop(0, false, 0x0001 | 0x0080);
                    if (desktop == IntPtr.Zero) {
                        if (!serviceAvailable) throw new InvalidOperationException("无法访问当前 Windows 桌面：" + Marshal.GetLastWin32Error());
                    } else {
                        string inputName = DesktopName(desktop), ownName = DesktopName(GetThreadDesktop(GetCurrentThreadId()));
                        if (!String.Equals(inputName, "Default", StringComparison.OrdinalIgnoreCase)) {
                            if (!serviceAvailable) throw new InvalidOperationException("请解锁 Windows 并关闭 UAC 提示后重试屏幕连接（" + inputName + "）");
                        } else if (ownName != inputName && !SetThreadDesktop(desktop)) {
                            if (!serviceAvailable) throw new InvalidOperationException("无法连接 Windows 输入桌面：" + Marshal.GetLastWin32Error());
                        }
                    }
                }
                if (args.Length == 1 && args[0] == "--displays") {
                    EnsureSharingEnabled();
                    if (!IsDefaultDesktopActive()) {
                        string svcJson;
                        if (TryServiceDisplaysJson(out svcJson)) { lock (OutputLock) { Console.Out.WriteLine(svcJson); Console.Out.Flush(); } return 0; }
                        EnsureDesktop();
                    }
                    var displays = EnumerateDisplays();
                    if (displays.Length == 0) throw new InvalidOperationException("这台 Windows 电脑未检测到可用显示器（无头模式）。请连接显示器、插入 HDMI/DP 欺骗器，或安装虚拟显示器驱动（Virtual Display Driver）后再试。");
                    Write(displays.Select((s, i) => new { screen = i, name = s.Primary ? "主屏幕" : "屏幕 " + (i + 1), w = s.Bounds.Width, h = s.Bounds.Height, main = s.Primary }).ToArray());
                    return 0;
                }
                if ((args.Length == 4 || args.Length == 5) && args[0] == "--capture") {
                    Capture(Int32.Parse(args[1]), Int32.Parse(args[2]), Int32.Parse(args[3]), args.Length == 5 ? Int32.Parse(args[4]) : 85);
                    return 0;
                }
                if (args.Length == 1 && args[0] == "--fusion") {
                    Fusion();
                    return 0;
                }
                if (args.Length == 7 && args[0] == "--fusion-video") {
                    CaptureWindowVideo(Int64.Parse(args[1]), Int32.Parse(args[2]), Int32.Parse(args[3]), Int32.Parse(args[4]), Int32.Parse(args[5]), args[6]);
                    return 0;
                }
                if (args.Length == 6 && args[0] == "--video") {
                    CaptureVideo(Int32.Parse(args[1]), Int32.Parse(args[2]), Int32.Parse(args[3]), Int32.Parse(args[4]), args[5]);
                    return 0;
                }
                if (args.Length == 2 && args[0] == "--shape") {
                    WatchShape(Int32.Parse(args[1]));
                    return 0;
                }
                if (args.Length == 1 && args[0] == "--audio") {
                    CaptureAudio();
                    return 0;
                }
                if (args.Length >= 1) {
                    int screenIndex = Int32.Parse(args[0]);
                    dryRun = args.Contains("--dry-run");
                    EnsureSharingEnabled();
                    if (!dryRun && TryRunElevatedControl(screenIndex)) return 0;
                    bounds = Display(screenIndex);
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

        static void EnsureSharingEnabled() {
            var home = Environment.GetEnvironmentVariable("LINKSHELL_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".linkshell");
            if (File.Exists(Path.Combine(home, "windows-screen-disabled"))) throw new InvalidOperationException("请在 LinkShell 桌面版设置中允许远程屏幕");
            if (!Environment.UserInteractive) throw new InvalidOperationException("屏幕共享需要登录 Windows 桌面");
        }

        static bool IsDefaultDesktopActive() {
            if (dryRun) return true;
            var current = OpenInputDesktop(0, false, 0x0001);
            if (current == IntPtr.Zero) return false;
            try { return String.Equals(DesktopName(current), "Default", StringComparison.OrdinalIgnoreCase); }
            finally { CloseDesktop(current); }
        }

        // Transient UAC prompts switch the input desktop to Winlogon for a few seconds.
        // Wait for Default to return instead of tearing down an active remote session.
        static bool WaitForDefaultDesktop(int maxWaitMs) {
            var waited = Stopwatch.StartNew();
            while (!ended) {
                EnsureSharingEnabled();
                if (IsDefaultDesktopActive()) return true;
                if (waited.ElapsedMilliseconds >= maxWaitMs) {
                    throw new InvalidOperationException("Windows 已锁定或正在显示安全桌面，请在电脑上解锁后重新连接");
                }
                Thread.Sleep(150);
            }
            return false;
        }

        static void EnsureDesktop() {
            EnsureSharingEnabled();
            if (!IsDefaultDesktopActive()) throw new InvalidOperationException("Windows 已锁定或正在显示安全桌面，请在电脑上解锁后重新连接");
        }
        internal static bool DisplayHasActiveMonitor(string deviceName) {
            if (String.IsNullOrEmpty(deviceName)) return false;
            for (uint j = 0; j < 16; j++) {
                var mon = new DISPLAY_DEVICE();
                mon.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
                if (!EnumDisplayDevices(deviceName, j, ref mon, 0)) break;
                if ((mon.StateFlags & 0x1u) != 0) return true;
            }
            return false;
        }

        // Gently asks DWM to present a fresh frame (wakes sleeping/headless displays without moving cursor).
        internal static void NudgeDesktopForCapture() {
            try { SetThreadExecutionState(0x00000002u | 0x00000001u); } catch { }
            try { RedrawWindow(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0x0001u | 0x0004u | 0x0080u | 0x0400u); } catch { }
        }

        // Query Win32 directly on each call: System.Windows.Forms.Screen.AllScreens caches monitor
        // bounds for the process lifetime when no WinForms message loop processes WM_DISPLAYCHANGE.
        internal static DisplayInfo[] EnumerateDisplays(bool probeMonitors = true) {
            var list = new List<DisplayInfo>();
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
                var info = new MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                if (GetMonitorInfo(monitor, ref info)) {
                    var rc = info.rcMonitor;
                    list.Add(new DisplayInfo {
                        Bounds = Rectangle.FromLTRB(rc.Left, rc.Top, rc.Right, rc.Bottom),
                        Primary = (info.dwFlags & 1u) != 0,
                        Monitor = monitor,
                        DeviceName = info.szDevice,
                        HasActiveMonitor = probeMonitors && DisplayHasActiveMonitor(info.szDevice),
                    });
                }
                return true;
            }, IntPtr.Zero);
            if (list.Count == 0) {
                int sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);
                if (sw > 0 && sh > 0) {
                    list.Add(new DisplayInfo { Bounds = new Rectangle(0, 0, sw, sh), Primary = true, Monitor = IntPtr.Zero, DeviceName = "", HasActiveMonitor = false });
                } else {
                    return Screen.AllScreens.Where(s => s.Bounds.Width > 0 && s.Bounds.Height > 0).Select(s => new DisplayInfo { Bounds = s.Bounds, Primary = s.Primary, Monitor = IntPtr.Zero, DeviceName = s.DeviceName, HasActiveMonitor = false }).ToArray();
                }
            }
            return list.OrderByDescending(d => d.Primary).ToArray();
        }

        internal static Rectangle DisplayBoundsAt(Point point) {
            var all = EnumerateDisplays();
            for (int i = 0; i < all.Length; i++) {
                if (all[i].Bounds.Contains(point)) return all[i].Bounds;
            }
            return all.Length > 0 ? all[0].Bounds : Screen.PrimaryScreen.Bounds;
        }

        static Rectangle VirtualScreenBounds() {
            int w = GetSystemMetrics(78);
            int h = GetSystemMetrics(79);
            if (w > 0 && h > 0) return new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), w, h);
            return SystemInformation.VirtualScreen;
        }

        internal static DisplayInfo DisplayEntry(int index, bool probeMonitors = true) {
            EnsureDesktop();
            var all = EnumerateDisplays(probeMonitors);
            if (all.Length == 0) throw new InvalidOperationException("这台 Windows 电脑未检测到可用显示器（无头模式）。请连接显示器、插入 HDMI/DP 欺骗器，或安装虚拟显示器驱动（Virtual Display Driver）后再试。");
            if (index < 0 || index >= all.Length) throw new ArgumentOutOfRangeException("display", "屏幕已断开，请重新打开屏幕共享");
            return all[index];
        }

        static Rectangle Display(int index) {
            return DisplayEntry(index, false).Bounds;
        }
        static void Write(object value) { lock (OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }

        static void Capture(int screen, int width, int fps, int quality) {
            EnsureSharingEnabled();
            bool hasActiveMonitor = true;
            Rectangle svcBounds;
            if (!IsDefaultDesktopActive() && TryServiceDisplayBounds(screen, out svcBounds)) {
                bounds = svcBounds;
            } else {
                var entry = DisplayEntry(screen);
                bounds = entry.Bounds;
                hasActiveMonitor = entry.HasActiveMonitor;
            }
            NudgeDesktopForCapture();
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
            string duplicationReason = "no active physical monitor (headless)";
            // Unplugged/headless displays still open DXGI without error but never present frames; go straight to GDI.
            var duplication = hasActiveMonitor ? DesktopDuplication.TryCreate(bounds, out duplicationReason) : null;
            long duplicationStartedAt = clock.ElapsedMilliseconds;
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
                                    EnsureSharingEnabled();
                                    if (!IsDefaultDesktopActive()) {
                                        if (duplication != null) { duplication.Dispose(); duplication = null; }
                                        Console.Error.WriteLine("[capture] desktop interrupted (UAC/secure desktop); switching to secure capture/wait");
                                        if (!TryStreamSecureDesktopJpeg(screen, w, Math.Min(15, profile.Fps), profile.Quality, output)) {
                                            if (!WaitForDefaultDesktop(120000)) break;
                                        }
                                        if (ended) break;
                                        if (!IsDefaultDesktopActive()) { checkedAt = -1000; continue; }
                                        CaptureWake.WaitOne(150);
                                        EnsureSharingEnabled();
                                        if (screenDC != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screenDC);
                                        screenDC = GetDC(IntPtr.Zero);
                                        if (screenDC == IntPtr.Zero) throw new InvalidOperationException("无法读取 Windows 桌面");
                                        hasActiveMonitor = DisplayEntry(screen).HasActiveMonitor;
                                        duplication = hasActiveMonitor ? DesktopDuplication.TryCreate(bounds, out duplicationReason) : null;
                                        duplicationStartedAt = clock.ElapsedMilliseconds;
                                        Interlocked.Exchange(ref forceFrame, 1);
                                        checkedAt = -1000;
                                        continue;
                                    }
                                    if (Display(screen) != bounds) throw new InvalidOperationException("屏幕布局已改变，请重新连接");
                                    checkedAt = began;
                                }
                                if (capturePaused) { CaptureWake.WaitOne(100); continue; }
                                // Scale while copying from the desktop DC, avoiding a full-resolution bitmap
                                // and the second, CPU-resampled GDI+ copy on every frame.
                                bool copied = false;
                                if (duplication != null) {
                                    try { copied = duplication.CopyTo(target, w, h, frame.Length == 0); }
                                    catch (Exception error) {
                                        duplication.Dispose(); duplication = null;
                                        if (!IsDefaultDesktopActive()) { checkedAt = -1000; continue; }
                                        Console.Error.WriteLine("[capture] GDI fallback: " + error.Message);
                                    }
                                    // Sleeping/unplugged displays open DXGI successfully yet return WaitTimeout forever.
                                    if (duplication != null && !copied && frame.Length == 0 && began - duplicationStartedAt >= 1000) {
                                        duplication.Dispose(); duplication = null;
                                        Console.Error.WriteLine("[capture] GDI fallback: DXGI produced no initial frame");
                                    }
                                }
                                if (duplication == null) {
                                    var dc = target.GetHdc();
                                    bool bltOk;
                                    int bltErr = 0;
                                    try {
                                        // HALFTONE (4) preserves crisp text edges when GDI downscales high-DPI displays.
                                        SetStretchBltMode(dc, 4); SetBrushOrgEx(dc, 0, 0, IntPtr.Zero);
                                        bltOk = StretchBlt(dc, 0, 0, w, h, screenDC, bounds.Left, bounds.Top, bounds.Width, bounds.Height, 0x40cc0020);
                                        if (!bltOk) bltErr = Marshal.GetLastWin32Error();
                                    } finally { target.ReleaseHdc(dc); }
                                    if (!bltOk) {
                                        if (!IsDefaultDesktopActive()) { checkedAt = -1000; continue; }
                                        throw new InvalidOperationException("Windows 屏幕采集失败：" + bltErr);
                                    }
                                    copied = true;
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
                                bool refine = !refined && began - lastChanged >= 200;
                                bool forced = Interlocked.Exchange(ref forceFrame, 0) != 0;
                                long comparedAt = clock.ElapsedMilliseconds, encodedAt = comparedAt;
                                if (changed || refine || forced || began - lastSent >= 2000) {
                                    int nextQuality = refine || refined ? Math.Min(95, profile.Quality + 15) : profile.Quality;
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

        static void WatchShape(int screen) {
            bounds = Display(screen);
            var eof = new Thread(() => {
                try {
                    string line;
                    while ((line = Console.ReadLine()) != null) {
                        if (line.Length > 1024) continue;
                        try {
                            var message = Json.Deserialize<Dictionary<string, object>>(line);
                            if (Str(message, "t") == "pause") {
                                capturePaused = Number(message, "value") != 0;
                                ShapeWake.Set();
                            }
                        } catch { }
                    }
                } finally { ended = true; ShapeWake.Set(); }
            }) { IsBackground = true };
            eof.Start();
            string lastId = null;
            var sent = new HashSet<string>();
            while (!ended) {
                EnsureSharingEnabled();
                if (!capturePaused && IsDefaultDesktopActive()) {
                    double displayScale = Math.Max(1.0, Math.Min(4.0, MonitorScale(new Point(bounds.Left + bounds.Width / 2, bounds.Top + bounds.Height / 2))));
                    var shape = CaptureCursorShape(displayScale);
                    if (shape != null && shape.Id != lastId) {
                        lastId = shape.Id;
                        Write(ShapeMessage(shape, bounds, displayScale, sent.Add(shape.Id)));
                    }
                }
                ShapeWake.WaitOne(200);
            }
        }

        internal static Dictionary<string, object> ShapeMessage(CursorShapeSnapshot shape, Rectangle displayBounds, double displayScale, bool includePng) {
            var message = new Dictionary<string, object> {
                { "t", "shape" },
                { "id", shape.Id },
            };
            if (includePng) {
                double scale = Math.Max(1.0, Math.Min(4.0, displayScale));
                message["png"] = shape.Png;
                message["w"] = shape.Width;
                message["h"] = shape.Height;
                message["hotX"] = shape.HotX;
                message["hotY"] = shape.HotY;
                message["scale"] = shape.Scale;
                message["displayW"] = Math.Round(displayBounds.Width / scale, 2);
                message["displayH"] = Math.Round(displayBounds.Height / scale, 2);
            }
            return message;
        }

        static bool DrawCursorToBitmap(IntPtr cursor, int width, int height, Color background, Bitmap target) {
            using (var graphics = Graphics.FromImage(target)) {
                graphics.Clear(background);
                IntPtr hdc = graphics.GetHdc();
                try {
                    return DrawIconEx(hdc, 0, 0, cursor, width, height, 0, IntPtr.Zero, 3);
                } finally {
                    graphics.ReleaseHdc(hdc);
                }
            }
        }

        internal static CursorShapeSnapshot CaptureCursorShape(double fallbackScale) {
            var ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == IntPtr.Zero) return null;

            IntPtr copied = IntPtr.Zero;
            var iconInfo = new ICONINFO();
            bool hasInfo = GetIconInfo(ci.hCursor, out iconInfo);
            if (!hasInfo) {
                copied = CopyIcon(ci.hCursor);
                if (copied != IntPtr.Zero) hasInfo = GetIconInfo(copied, out iconInfo);
            }
            if (!hasInfo) {
                if (copied != IntPtr.Zero) DestroyIcon(copied);
                return null;
            }

            IntPtr drawHandle = copied != IntPtr.Zero ? copied : ci.hCursor;
            try {
                int pxW = 0, pxH = 0;
                BITMAP bm;
                if (iconInfo.hbmColor != IntPtr.Zero && GetObject(iconInfo.hbmColor, Marshal.SizeOf(typeof(BITMAP)), out bm) > 0) {
                    pxW = bm.bmWidth;
                    pxH = Math.Abs(bm.bmHeight);
                } else if (iconInfo.hbmMask != IntPtr.Zero && GetObject(iconInfo.hbmMask, Marshal.SizeOf(typeof(BITMAP)), out bm) > 0) {
                    pxW = bm.bmWidth;
                    pxH = Math.Max(1, Math.Abs(bm.bmHeight) / 2);
                } else {
                    pxW = SystemInformation.CursorSize.Width;
                    pxH = SystemInformation.CursorSize.Height;
                }
                if (pxW <= 0 || pxH <= 0 || pxW > 512 || pxH > 512) return null;

                double scale = Math.Max(1.0, Math.Min(4.0, MonitorScale(new Point(ci.ptScreenPos.X, ci.ptScreenPos.Y))));
                if (scale <= 0) scale = Math.Max(1.0, Math.Min(4.0, fallbackScale));
                double logicalW = Math.Round(pxW / scale, 2);
                double logicalH = Math.Round(pxH / scale, 2);
                if (logicalW <= 0 || logicalH <= 0 || logicalW > 256 || logicalH > 256) return null;

                int hotPxX = Math.Max(0, Math.Min(pxW, iconInfo.xHotspot));
                int hotPxY = Math.Max(0, Math.Min(pxH, iconInfo.yHotspot));

                using (var black = new Bitmap(pxW, pxH, PixelFormat.Format32bppArgb))
                using (var white = new Bitmap(pxW, pxH, PixelFormat.Format32bppArgb))
                using (var output = new Bitmap(pxW, pxH, PixelFormat.Format32bppArgb)) {
                    if (!DrawCursorToBitmap(drawHandle, pxW, pxH, Color.Black, black)) return null;
                    if (!DrawCursorToBitmap(drawHandle, pxW, pxH, Color.White, white)) return null;

                    var rect = new Rectangle(0, 0, pxW, pxH);
                    var bData = black.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                    var wData = white.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                    var oData = output.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                    byte[] packed = new byte[pxW * pxH * 4];
                    try {
                        int bStride = Math.Abs(bData.Stride);
                        int wStride = Math.Abs(wData.Stride);
                        int oStride = Math.Abs(oData.Stride);
                        byte[] bBytes = new byte[bStride * pxH];
                        byte[] wBytes = new byte[wStride * pxH];
                        byte[] oBytes = new byte[oStride * pxH];
                        Marshal.Copy(bData.Scan0, bBytes, 0, bBytes.Length);
                        Marshal.Copy(wData.Scan0, wBytes, 0, wBytes.Length);

                        for (int y = 0; y < pxH; y++) {
                            int bRow = y * bStride, wRow = y * wStride, oRow = y * oStride, pRow = y * pxW * 4;
                            for (int x = 0; x < pxW; x++) {
                                int bi = bRow + x * 4, wi = wRow + x * 4, oi = oRow + x * 4, pi = pRow + x * 4;
                                byte bB = bBytes[bi], bG = bBytes[bi + 1], bR = bBytes[bi + 2];
                                byte wB = wBytes[wi], wG = wBytes[wi + 1], wR = wBytes[wi + 2];
                                byte outB, outG, outR, outA;
                                if (wB < bB || wG < bG || wR < bR) {
                                    // Monochrome XOR-inverted cursor pixels (e.g. classic I-beam): render opaque black so they stay visible over video.
                                    outB = 0; outG = 0; outR = 0; outA = 255;
                                } else {
                                    int diff = ((wR - bR) + (wG - bG) + (wB - bB)) / 3;
                                    int a = Math.Max(0, Math.Min(255, 255 - diff));
                                    if (a == 0) {
                                        outB = 0; outG = 0; outR = 0; outA = 0;
                                    } else if (a == 255) {
                                        outB = bB; outG = bG; outR = bR; outA = 255;
                                    } else {
                                        outA = (byte)a;
                                        outB = (byte)Math.Min(255, bB * 255 / a);
                                        outG = (byte)Math.Min(255, bG * 255 / a);
                                        outR = (byte)Math.Min(255, bR * 255 / a);
                                    }
                                }
                                oBytes[oi] = packed[pi] = outB;
                                oBytes[oi + 1] = packed[pi + 1] = outG;
                                oBytes[oi + 2] = packed[pi + 2] = outR;
                                oBytes[oi + 3] = packed[pi + 3] = outA;
                            }
                        }
                        Marshal.Copy(oBytes, 0, oData.Scan0, oBytes.Length);
                    } finally {
                        black.UnlockBits(bData);
                        white.UnlockBits(wData);
                        output.UnlockBits(oData);
                    }

                    string id;
                    using (var sha = SHA256.Create()) {
                        sha.TransformBlock(packed, 0, packed.Length, null, 0);
                        byte[] meta = Encoding.UTF8.GetBytes(String.Format(CultureInfo.InvariantCulture, "|{0}x{1}|{2},{3}|{4}", pxW, pxH, hotPxX, hotPxY, Math.Round(scale, 2)));
                        sha.TransformFinalBlock(meta, 0, meta.Length);
                        var sb = new StringBuilder(16);
                        for (int i = 0; i < 8; i++) sb.Append(sha.Hash[i].ToString("x2", CultureInfo.InvariantCulture));
                        id = sb.ToString();
                    }

                    lock (CursorShapeCache) {
                        CursorShapeSnapshot cached;
                        if (CursorShapeCache.TryGetValue(id, out cached)) return cached;
                        using (var ms = new MemoryStream()) {
                            output.Save(ms, ImageFormat.Png);
                            if (CursorShapeCache.Count >= 64) CursorShapeCache.Clear();
                            var snapshot = new CursorShapeSnapshot {
                                Id = id,
                                Png = Convert.ToBase64String(ms.ToArray()),
                                Width = logicalW,
                                Height = logicalH,
                                HotX = Math.Round(hotPxX / scale, 2),
                                HotY = Math.Round(hotPxY / scale, 2),
                                Scale = Math.Round(scale, 2),
                            };
                            CursorShapeCache[id] = snapshot;
                            return snapshot;
                        }
                    }
                }
            } finally {
                if (iconInfo.hbmMask != IntPtr.Zero) DeleteObject(iconInfo.hbmMask);
                if (iconInfo.hbmColor != IntPtr.Zero) DeleteObject(iconInfo.hbmColor);
                if (copied != IntPtr.Zero) DestroyIcon(copied);
            }
        }

        static void Control() {
            Write(new { t = "ready", trusted = true, app = "LinkShell" });
            var next = Task.Run(() => Console.ReadLine());
            POINT last = new POINT { X = Int32.MinValue, Y = Int32.MinValue };
            bool inSecureDesktop = false;
            for (;;) {
                // Recheck while idle too: disabling sharing stops control immediately, while UAC
                // pauses input and releases held drags without tearing down the session.
                EnsureSharingEnabled();
                if (!IsDefaultDesktopActive()) {
                    if (!inSecureDesktop) { Release(); inSecureDesktop = true; }
                    if (!next.Wait(150)) continue;
                    var skipped = next.Result;
                    if (skipped == null) return;
                    next = Task.Run(() => Console.ReadLine());
                    continue;
                }
                inSecureDesktop = false;
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
                Dictionary<string, object> e;
                try { e = Json.Deserialize<Dictionary<string, object>>(line); }
                catch { continue; }
                if (e == null) continue;
                if (dryRun) { e["t"] = "posted"; Write(e); continue; }
                try {
                    Handle(e);
                } catch (Exception error) {
                    // UIPI / elevated focus / transient UAC can reject SendInput without invalidating the session.
                    Release();
                    Console.Error.WriteLine("[control] " + error.Message);
                }
            }
        }
        static string Str(Dictionary<string, object> e, string key) { object value; return e.TryGetValue(key, out value) ? Convert.ToString(value, CultureInfo.InvariantCulture) : ""; }
        static double Number(Dictionary<string, object> e, string key) { object value; return e.TryGetValue(key, out value) ? Convert.ToDouble(value, CultureInfo.InvariantCulture) : 0; }
        static void Post(INPUT input) {
            if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("Windows 拒绝了输入；无法控制管理员窗口、锁屏或 UAC 安全桌面");
        }
        static void Mouse(uint flags, int x = 0, int y = 0, int data = 0) { Post(new INPUT { type = 0, data = new INPUTUNION { mouse = new MOUSEINPUT { dx = x, dy = y, mouseData = unchecked((uint)data), flags = flags } } }); }
        static readonly HashSet<uint> HeldScans = new HashSet<uint>();
        static void Key(ushort vk, bool up, ushort scan = 0, bool unicode = false) {
            uint extended = (vk >= 0x21 && vk <= 0x2e) || vk == 0x5b ? 1u : 0u;
            Post(new INPUT { type = 1, data = new INPUTUNION { key = new KEYBDINPUT { vk = vk, scan = scan, flags = (up ? 2u : 0u) | (unicode ? 4u : extended) } } });
            if (!unicode) { if (up) HeldKeys.Remove(vk); else HeldKeys.Add(vk); }
        }
        static void ScanKey(ushort scan, bool up, bool extended) {
            // KEYEVENTF_SCANCODE (0x8) | KEYEVENTF_KEYUP (0x2) | KEYEVENTF_EXTENDEDKEY (0x1)
            Post(new INPUT { type = 1, data = new INPUTUNION { key = new KEYBDINPUT { vk = 0, scan = scan, flags = 8u | (up ? 2u : 0u) | (extended ? 1u : 0u) } } });
            uint packed = ((extended ? 1u : 0u) << 16) | scan;
            if (up) HeldScans.Remove(packed); else HeldScans.Add(packed);
        }
        static void Release() {
            if (dryRun) return;
            foreach (ushort key in HeldKeys.ToArray()) { try { Key(key, true); } catch {} }
            foreach (uint packed in HeldScans.ToArray()) { try { ScanKey((ushort)(packed & 0xFFFFu), true, (packed >> 16) != 0); } catch {} }
            HeldScans.Clear();
            try { if (leftDown) Mouse(0x0004); if (rightDown) Mouse(0x0010); } catch {}
            leftDown = rightDown = false;
        }
        static void Handle(Dictionary<string, object> e) {
            string type = Str(e, "t");
            if (type == "move") {
                var all = VirtualScreenBounds();
                var x = bounds.Left + (int)(Math.Max(0, Math.Min(1, Number(e, "x"))) * (bounds.Width - 1));
                var y = bounds.Top + (int)(Math.Max(0, Math.Min(1, Number(e, "y"))) * (bounds.Height - 1));
                Mouse(0x8000 | 0x4000 | 0x0001, (int)((long)(x - all.Left) * 65535 / Math.Max(1, all.Width - 1)), (int)((long)(y - all.Top) * 65535 / Math.Max(1, all.Height - 1)));
                return;
            }
            if (type == "keydown" || type == "keyup") {
                ushort scan;
                bool ext;
                if (TryMapW3cCodeToScan(Str(e, "c"), out scan, out ext)) {
                    ScanKey(scan, type == "keyup", ext);
                }
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
            } finally {
                for (int i = modifiers.Count - 1; i >= 0; i--) {
                    try { Key(modifiers[i], true); }
                    catch { HeldKeys.Remove(modifiers[i]); }
                }
            }
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
        static readonly Dictionary<string, uint> W3cScanMap = new Dictionary<string, uint> {
            { "Escape", 0x01u }, { "Digit1", 0x02u }, { "Digit2", 0x03u }, { "Digit3", 0x04u }, { "Digit4", 0x05u },
            { "Digit5", 0x06u }, { "Digit6", 0x07u }, { "Digit7", 0x08u }, { "Digit8", 0x09u }, { "Digit9", 0x0Au },
            { "Digit0", 0x0Bu }, { "Minus", 0x0Cu }, { "Equal", 0x0Du }, { "Backspace", 0x0Eu }, { "Tab", 0x0Fu },
            { "KeyQ", 0x10u }, { "KeyW", 0x11u }, { "KeyE", 0x12u }, { "KeyR", 0x13u }, { "KeyT", 0x14u },
            { "KeyY", 0x15u }, { "KeyU", 0x16u }, { "KeyI", 0x17u }, { "KeyO", 0x18u }, { "KeyP", 0x19u },
            { "BracketLeft", 0x1Au }, { "BracketRight", 0x1Bu }, { "Enter", 0x1Cu }, { "ControlLeft", 0x1Du },
            { "KeyA", 0x1Eu }, { "KeyS", 0x1Fu }, { "KeyD", 0x20u }, { "KeyF", 0x21u }, { "KeyG", 0x22u },
            { "KeyH", 0x23u }, { "KeyJ", 0x24u }, { "KeyK", 0x25u }, { "KeyL", 0x26u }, { "Semicolon", 0x27u },
            { "Quote", 0x28u }, { "Backquote", 0x29u }, { "ShiftLeft", 0x2Au }, { "Backslash", 0x2Bu },
            { "KeyZ", 0x2Cu }, { "KeyX", 0x2Du }, { "KeyC", 0x2Eu }, { "KeyV", 0x2Fu }, { "KeyB", 0x30u },
            { "KeyN", 0x31u }, { "KeyM", 0x32u }, { "Comma", 0x33u }, { "Period", 0x34u }, { "Slash", 0x35u },
            { "ShiftRight", 0x36u }, { "NumpadMultiply", 0x37u }, { "AltLeft", 0x38u }, { "Space", 0x39u },
            { "CapsLock", 0x3Au }, { "F1", 0x3Bu }, { "F2", 0x3Cu }, { "F3", 0x3Du }, { "F4", 0x3Eu },
            { "F5", 0x3Fu }, { "F6", 0x40u }, { "F7", 0x41u }, { "F8", 0x42u }, { "F9", 0x43u },
            { "F10", 0x44u }, { "F11", 0x57u }, { "F12", 0x58u }, { "ScrollLock", 0x46u },
            { "Numpad7", 0x47u }, { "Numpad8", 0x48u }, { "Numpad9", 0x49u }, { "NumpadSubtract", 0x4Au },
            { "Numpad4", 0x4Bu }, { "Numpad5", 0x4Cu }, { "Numpad6", 0x4Du }, { "NumpadAdd", 0x4Eu },
            { "Numpad1", 0x4Fu }, { "Numpad2", 0x50u }, { "Numpad3", 0x51u }, { "Numpad0", 0x52u },
            { "NumpadDecimal", 0x53u },
            // Extended scan codes have bit 16 set.
            { "NumLock", 0x10045u }, { "NumpadEnter", 0x1001Cu }, { "NumpadDivide", 0x10035u },
            { "ControlRight", 0x1001Du }, { "AltRight", 0x10038u },
            { "MetaLeft", 0x1005Bu }, { "OSLeft", 0x1005Bu }, { "MetaRight", 0x1005Cu }, { "OSRight", 0x1005Cu },
            { "ContextMenu", 0x1005Du },
            { "Home", 0x10047u }, { "ArrowUp", 0x10048u }, { "PageUp", 0x10049u },
            { "ArrowLeft", 0x1004Bu }, { "ArrowRight", 0x1004Du },
            { "End", 0x1004Fu }, { "ArrowDown", 0x10050u }, { "PageDown", 0x10051u },
            { "Insert", 0x10052u }, { "Delete", 0x10053u }, { "PrintScreen", 0x10037u },
        };
        static bool TryMapW3cCodeToScan(string code, out ushort scan, out bool extended) {
            uint packed;
            if (!string.IsNullOrEmpty(code) && W3cScanMap.TryGetValue(code, out packed)) {
                scan = (ushort)(packed & 0xFFFFu);
                extended = (packed >> 16) != 0;
                return true;
            }
            scan = 0;
            extended = false;
            return false;
        }
    }
}
