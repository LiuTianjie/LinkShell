using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace LinkShell.Windows {
    /// <summary>
    /// Fusion on Windows (docs/v2/fusion.md §8.2): the fused apps' windows, the app catalog, launching,
    /// resizing, focusing, closing and typing, as JSON lines with the host on stdin / stdout.
    /// Pictures come from --fusion-video (VideoCapture.cs). C# 5: the Framework's own compiler.
    /// </summary>
    internal static partial class ScreenHelper {
        [StructLayout(LayoutKind.Sequential)] internal struct RECT { public int Left, Top, Right, Bottom; }
        delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint to, bool on);
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT point, uint flags);
        [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref int length, StringBuilder id);
        [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [Out, MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHCreateItemFromParsingName(string path, IntPtr bind, ref Guid iid, [Out, MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT value);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
        [DllImport("gdi32.dll")] static extern int GetObject(IntPtr handle, int size, out BITMAP bitmap);

        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IPropertyStore {
            int GetCount(out uint count);
            int GetAt(uint index, out PROPERTYKEY key);
            int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
            int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
            int Commit();
        }
        [ComImport, Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IShellItemImageFactory { int GetImage(SIZE size, int flags, out IntPtr bitmap); }
        [StructLayout(LayoutKind.Sequential, Pack = 4)] internal struct PROPERTYKEY { public Guid fmtid; public uint pid; }
        [StructLayout(LayoutKind.Explicit, Size = 24)] internal struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointer; }
        [StructLayout(LayoutKind.Sequential)] internal struct SIZE { public int cx, cy; }
        [StructLayout(LayoutKind.Sequential)] internal struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public ushort bmPlanes, bmBitsPixel; public IntPtr bmBits; }

        const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
        const int WS_CAPTION = 0x00C00000, WS_POPUP = unchecked((int)0x80000000), WS_CHILD = 0x40000000;
        const int WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000, WS_EX_APPWINDOW = 0x40000;
        const int HTCLIENT = 1, HTCAPTION = 2, HTMINBUTTON = 8, HTMAXBUTTON = 9, HTCLOSE = 20;
        static readonly string[] PopupClasses = { "#32768", "tooltips_class32", "ComboLBox", "DropDown", "Xaml_WindowedPopupClass", "Chrome_WidgetWin_2" };

        sealed class FusionWindow {
            public IntPtr Handle; public uint Pid; public string App = ""; public string Title = "";
            public RECT Frame; public int Monitor; public bool Popup; public IntPtr Owner; public bool Minimized;
        }

        static readonly ConcurrentQueue<Dictionary<string, object>> FusionCommands = new ConcurrentQueue<Dictionary<string, object>>();
        static readonly HashSet<string> Fused = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        /// <summary>A classic app's catalog id by its executable, lower-cased (`{FOLDERID}\path.exe` resolved).</summary>
        static readonly Dictionary<string, string> AppByExe = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        /// <summary>Title bar measurements by window and size: probing is cheap, but not 30 times a second.</summary>
        static readonly Dictionary<IntPtr, KeyValuePair<string, object>> ChromeCache = new Dictionary<IntPtr, KeyValuePair<string, object>>();
        static readonly Dictionary<IntPtr, long> ChromeProbed = new Dictionary<IntPtr, long>();

        /// <summary>
        /// The catalog and icons go through the shell's COM objects, which can take seconds: they run
        /// on their own STA thread, so window tracking and input never wait behind them.
        /// </summary>
        static readonly BlockingCollection<Dictionary<string, object>> ShellRequests = new BlockingCollection<Dictionary<string, object>>();
        static readonly object CatalogLock = new object();

        static void ShellWorker() {
            try { Catalog(); } catch (Exception error) { Write(new { t = "log", message = "catalog: " + error.Message }); }
            foreach (var request in ShellRequests.GetConsumingEnumerable()) {
                object rid = request.ContainsKey("rid") ? request["rid"] : null;
                try {
                    if (Str(request, "t") == "apps") Write(new { rid = rid, apps = Catalog() });
                    else Write(new { rid = rid, png = Icon(Str(request, "app")) });
                } catch (Exception error) { Write(new { rid = rid, error = error.Message }); }
            }
        }

        static void Fusion() {
            EnsureDesktop();
            var shell = new Thread(ShellWorker) { IsBackground = true };
            shell.SetApartmentState(ApartmentState.STA);
            shell.Start();
            var reading = new System.Web.Script.Serialization.JavaScriptSerializer();
            var reader = new Thread(() => {
                try {
                    string line;
                    while ((line = Console.ReadLine()) != null) {
                        if (line.Length > 64000) continue;
                        // Its own serializer: the main loop writes with the shared one at the same time.
                        try { FusionCommands.Enqueue(reading.Deserialize<Dictionary<string, object>>(line)); } catch { }
                    }
                } finally { ended = true; }
            }) { IsBackground = true };
            reader.Start();
            WriteMonitors();
            string last = null;
            var monitorsAt = Stopwatch.StartNew();
            while (!ended) {
                Dictionary<string, object> command;
                while (FusionCommands.TryDequeue(out command)) {
                    try { FusionCommand(command); }
                    catch (Exception error) { Write(new { t = "log", message = error.Message, rid = command.ContainsKey("rid") ? command["rid"] : null }); }
                }
                try {
                    EnsureDesktop();
                    var list = Json.Serialize(FusionWindowsJson());
                    if (list != last) { lock (OutputLock) { Console.Out.WriteLine("{\"t\":\"windows\",\"windows\":" + list + "}"); Console.Out.Flush(); } last = list; }
                } catch (InvalidOperationException) {
                    // Locked or on the secure desktop: nothing can be captured or typed until it is back.
                    if (last != "[]") { Write(new { t = "windows", windows = new object[0] }); last = "[]"; }
                } catch (Exception error) {
                    // One window that can't be read must not end the helper and every session's windows with it.
                    Write(new { t = "log", message = "windows: " + error.Message });
                }
                if (monitorsAt.ElapsedMilliseconds > 2000) { WriteMonitors(); monitorsAt.Restart(); }
                Thread.Sleep(33);
            }
            Release();
        }

        static string lastMonitors;
        static void WriteMonitors() {
            var screens = System.Windows.Forms.Screen.AllScreens;
            var list = screens.Select((s, i) => new { index = i, x = s.Bounds.X, y = s.Bounds.Y, w = s.Bounds.Width, h = s.Bounds.Height, scale = MonitorScale(new Point(s.Bounds.X + s.Bounds.Width / 2, s.Bounds.Y + s.Bounds.Height / 2)) }).ToArray();
            var text = Json.Serialize(list);
            if (text == lastMonitors) return;
            lastMonitors = text;
            Write(new { t = "monitors", monitors = list });
        }

        static double MonitorScale(Point at) {
            uint dx, dy;
            try {
                var monitor = MonitorFromPoint(new POINT { X = at.X, Y = at.Y }, 2);
                if (GetDpiForMonitor(monitor, 0, out dx, out dy) == 0 && dx > 0) return dx / 96.0;
            } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
            return 1;
        }

        static void FusionCommand(Dictionary<string, object> c) {
            string type = Str(c, "t");
            object rid = c.ContainsKey("rid") ? c["rid"] : null;
            IntPtr hwnd = c.ContainsKey("hwnd") ? new IntPtr(Convert.ToInt64(c["hwnd"])) : IntPtr.Zero;
            switch (type) {
                case "apps": case "icon": ShellRequests.Add(c); return;
                case "launch": {
                    string app = Str(c, "app");
                    lock (Fused) Fused.Add(app);
                    try {
                        Process.Start(new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + app) { UseShellExecute = false });
                        Write(new { rid = rid, ok = true });
                    } catch (Exception error) { Write(new { rid = rid, ok = false, error = error.Message }); }
                    return;
                }
                case "fuse": {
                    // The whole set, the current session's: a later session starts from nothing.
                    object raw;
                    lock (Fused) {
                        Fused.Clear();
                        if (c.TryGetValue("apps", out raw) && raw != null) foreach (object app in (System.Collections.IEnumerable)raw) Fused.Add(Convert.ToString(app));
                    }
                    return;
                }
                case "quit": {
                    string app = Str(c, "app");
                    bool force = c.ContainsKey("force") && Convert.ToBoolean(c["force"]);
                    foreach (var w in FusionWindows(true).Where(w => !w.Popup && String.Equals(w.App, app, StringComparison.OrdinalIgnoreCase))) {
                        if (force) { try { Process.GetProcessById((int)w.Pid).Kill(); } catch { } }
                        else PostMessage(w.Handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
                    }
                    return;
                }
                case "resize": {
                    RECT window, frame;
                    if (!GetWindowRect(hwnd, out window) || !WindowFrame(hwnd, out frame)) return;
                    // The size asked for is the visible frame's; SetWindowPos also counts the invisible resize borders.
                    int extraW = (window.Right - window.Left) - (frame.Right - frame.Left), extraH = (window.Bottom - window.Top) - (frame.Bottom - frame.Top);
                    SetWindowPos(hwnd, IntPtr.Zero, 0, 0, (int)Number(c, "w") + extraW, (int)Number(c, "h") + extraH, 0x0002 | 0x0004 | 0x0010);
                    return;
                }
                case "focus": Focus(hwnd); return;
                case "close": PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); return;
                case "input": {
                    object raw;
                    if (!c.TryGetValue("event", out raw)) return;
                    var e = raw as Dictionary<string, object>;
                    if (e == null) return;
                    if (hwnd != IntPtr.Zero) {
                        RECT frame;
                        if (!WindowFrame(hwnd, out frame)) return;
                        bounds = new Rectangle(frame.Left, frame.Top, frame.Right - frame.Left, frame.Bottom - frame.Top);
                    } else {
                        var screens = System.Windows.Forms.Screen.AllScreens;
                        int index = (int)Number(c, "monitor");
                        if (index < 0 || index >= screens.Length) return;
                        bounds = screens[index].Bounds;
                    }
                    if (bounds.Width < 2 || bounds.Height < 2) return;
                    string kind = Str(e, "t");
                    if (hwnd != IntPtr.Zero && kind != "move" && kind != "scroll") {
                        Focus(hwnd);
                        if (!OnTop(hwnd, kind == "down")) {
                            // SendInput goes to whatever is under the pointer: never press another app's window.
                            Write(new { t = "log", message = "input dropped: window " + hwnd.ToInt64() + " is not in front" });
                            return;
                        }
                    }
                    Handle(e);
                    return;
                }
            }
        }

        /// <summary>
        /// Windows lets a process take the foreground only right after input of its own: a lone Alt
        /// press (sent and released at once, so no menu opens) is that input, then attaching to the
        /// foreground thread covers older builds.
        /// </summary>
        static void Focus(IntPtr hwnd) {
            if (!IsWindow(hwnd)) return;
            if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
            if (GetForegroundWindow() == hwnd) return;
            if (!HeldKeys.Contains(0x12)) { Key(0x12, false); Key(0x12, true); }
            if (SetForegroundWindow(hwnd) && GetForegroundWindow() == hwnd) return;
            uint pid;
            uint target = GetWindowThreadProcessId(hwnd, out pid), front = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            bool attached = front != 0 && front != target && AttachThreadInput(front, target, true);
            try { SetForegroundWindow(hwnd); } finally { if (attached) AttachThreadInput(front, target, false); }
        }

        /// <summary>The target is the foreground window (or owns it), and for a press the pointer is over it or its popups.</summary>
        static bool OnTop(IntPtr hwnd, bool press) {
            uint pid, frontPid;
            GetWindowThreadProcessId(hwnd, out pid);
            IntPtr front = GetForegroundWindow();
            GetWindowThreadProcessId(front, out frontPid);
            if (front != hwnd && GetAncestor(front, 3) != hwnd && frontPid != pid) return false;
            if (!press) return true;
            POINT at;
            if (!GetCursorPos(out at)) return true;
            uint underPid;
            GetWindowThreadProcessId(GetAncestor(WindowFromPoint(at), 2), out underPid);
            return underPid == pid;
        }

        internal static bool WindowFrame(IntPtr hwnd, out RECT frame) {
            if (!IsWindow(hwnd)) { frame = new RECT(); return false; }
            try { if (DwmGetWindowAttribute(hwnd, 9, out frame, Marshal.SizeOf(typeof(RECT))) == 0 && frame.Right > frame.Left) return true; }
            catch (DllNotFoundException) { }
            return GetWindowRect(hwnd, out frame);
        }

        static string ClassOf(IntPtr hwnd) { var name = new StringBuilder(256); GetClassName(hwnd, name, name.Capacity); return name.ToString(); }

        static List<FusionWindow> FusionWindows(bool all = false) {
            HashSet<string> fused;
            lock (Fused) fused = new HashSet<string>(Fused, StringComparer.OrdinalIgnoreCase);
            var found = new List<FusionWindow>();
            var screens = System.Windows.Forms.Screen.AllScreens;
            EnumWindows((hwnd, _) => {
                if (!IsWindowVisible(hwnd)) return true;
                int cloaked;
                try { if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true; } catch (DllNotFoundException) { }
                RECT frame;
                if (!WindowFrame(hwnd, out frame) || frame.Right - frame.Left < 2 || frame.Bottom - frame.Top < 2) return true;
                int style = GetWindowLong(hwnd, GWL_STYLE), ex = GetWindowLong(hwnd, GWL_EXSTYLE);
                if ((style & WS_CHILD) != 0) return true;
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                string cls = ClassOf(hwnd);
                IntPtr owner = GetWindow(hwnd, 4);
                bool popup = PopupClasses.Contains(cls) || ((ex & WS_EX_TOOLWINDOW) != 0 && (style & WS_CAPTION) != WS_CAPTION) || ((style & WS_POPUP) != 0 && (style & WS_CAPTION) == 0 && owner != IntPtr.Zero && (ex & WS_EX_APPWINDOW) == 0);
                if (cls == "SysShadow") return true;
                var title = new StringBuilder(512);
                GetWindowText(hwnd, title, title.Capacity);
                var center = new Point((frame.Left + frame.Right) / 2, (frame.Top + frame.Bottom) / 2);
                int monitor = Array.FindIndex(screens, s => s.Bounds.Contains(center));
                found.Add(new FusionWindow {
                    Handle = hwnd, Pid = pid, App = AppOf(hwnd, pid), Title = title.ToString(), Frame = frame,
                    Monitor = Math.Max(0, monitor), Popup = popup, Owner = owner, Minimized = IsIconic(hwnd),
                });
                return true;
            }, IntPtr.Zero);
            if (all) return found;
            var shown = found.Where(w => !w.Popup && fused.Contains(w.App)).ToList();
            var shownPids = new HashSet<uint>(shown.Select(w => w.Pid));
            var result = new List<FusionWindow>(shown);
            foreach (var p in found.Where(w => w.Popup && shownPids.Contains(w.Pid))) {
                // A menu has no owner window: it belongs to its app's front-most window here.
                var owner = shown.FirstOrDefault(w => w.Handle == p.Owner) ?? shown.FirstOrDefault(w => w.Pid == p.Pid);
                if (owner == null) continue;
                p.Owner = owner.Handle; p.App = owner.App;
                result.Add(p);
            }
            return result;
        }

        static object[] FusionWindowsJson() {
            return FusionWindows(false).Select(w => {
                var entry = new Dictionary<string, object> {
                    { "id", (long)w.Handle.ToInt64() & 0xffffffffL }, { "pid", w.Pid }, { "app", w.App }, { "title", w.Title },
                    { "x", w.Frame.Left }, { "y", w.Frame.Top }, { "w", w.Frame.Right - w.Frame.Left }, { "h", w.Frame.Bottom - w.Frame.Top },
                    { "monitor", w.Monitor }, { "popup", w.Popup }, { "minimized", w.Minimized },
                };
                if (w.Popup) entry["owner"] = (long)w.Owner.ToInt64() & 0xffffffffL;
                else {
                    var chrome = Chrome(w);
                    foreach (var pair in chrome) entry[pair.Key] = pair.Value;
                }
                return (object)entry;
            }).ToArray();
        }

        /// <summary>
        /// The title bar as the window answers WM_NCHITTEST along it: the caption buttons, and the
        /// interactive parts (Chrome's tabs, a search box) the local side must not take for dragging.
        /// </summary>
        static Dictionary<string, object> Chrome(FusionWindow w) {
            int width = w.Frame.Right - w.Frame.Left, height = w.Frame.Bottom - w.Frame.Top;
            string key = width + "x" + height;
            KeyValuePair<string, object> cached;
            bool known = ChromeCache.TryGetValue(w.Handle, out cached);
            if (known && cached.Key == key) return (Dictionary<string, object>)cached.Value;
            // While a window is being resized its size changes every frame: probe at most twice a second.
            long now = Environment.TickCount;
            long probed;
            if (known && ChromeProbed.TryGetValue(w.Handle, out probed) && now - probed < 500) return (Dictionary<string, object>)cached.Value;
            ChromeProbed[w.Handle] = now;
            int band = (int)Math.Round(32 * MonitorScale(new Point(w.Frame.Left + width / 2, w.Frame.Top + 8)));
            // At most 96 probes of 10 ms: a hung app costs the loop a second, once.
            int y = w.Frame.Top + Math.Max(4, band / 2), step = Math.Max(Math.Max(4, band / 8), width / 96 + 1);
            var spans = new List<KeyValuePair<int, int[]>>();
            int current = -1, start = 0;
            for (int x = w.Frame.Left + 1; x < w.Frame.Right; x += step) {
                IntPtr result;
                int code = SendMessageTimeout(w.Handle, 0x0084, IntPtr.Zero, new IntPtr(((y & 0xffff) << 16) | (x & 0xffff)), 0x0002, 10, out result) == IntPtr.Zero ? -1 : unchecked((int)result.ToInt64());
                if (code != current) {
                    if (current != -1) spans.Add(new KeyValuePair<int, int[]>(current, new[] { start, x }));
                    current = code; start = x;
                }
            }
            if (current != -1) spans.Add(new KeyValuePair<int, int[]>(current, new[] { start, w.Frame.Right }));
            Func<int[], object> rect = s => new Dictionary<string, object> { { "x", s[0] - w.Frame.Left }, { "y", 0 }, { "w", s[1] - s[0] }, { "h", band } };
            var buttons = new Dictionary<string, object>();
            foreach (var span in spans) {
                if (span.Key == HTMINBUTTON) buttons["minimize"] = rect(span.Value);
                else if (span.Key == HTMAXBUTTON) buttons["zoom"] = rect(span.Value);
                else if (span.Key == HTCLOSE) buttons["close"] = rect(span.Value);
            }
            var hitrects = spans.Where(s => s.Key == HTCLIENT && s.Value[1] - s.Value[0] >= step).Select(s => rect(s.Value)).Take(64).ToArray();
            var chrome = new Dictionary<string, object> { { "buttons", buttons }, { "hitrects", hitrects } };
            ChromeCache[w.Handle] = new KeyValuePair<string, object>(key, chrome);
            if (ChromeCache.Count > 256) { ChromeCache.Clear(); ChromeProbed.Clear(); }
            return chrome;
        }

        static readonly Guid AppUserModelKey = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        static readonly Dictionary<uint, string> AppByPid = new Dictionary<uint, string>();

        /// <summary>The catalog's id for a window: its own AppUserModelID, its process's, or its executable's entry.</summary>
        static string AppOf(IntPtr hwnd, uint pid) {
            string id = WindowAppId(hwnd);
            if (!String.IsNullOrEmpty(id)) return id;
            string cached;
            if (AppByPid.TryGetValue(pid, out cached)) return cached;
            string result = "";
            IntPtr process = OpenProcess(0x1000, false, pid);
            if (process != IntPtr.Zero) {
                try {
                    int length = 512; var buffer = new StringBuilder(length);
                    if (GetApplicationUserModelId(process, ref length, buffer) == 0) result = buffer.ToString();
                    if (result == "") {
                        length = 1024; buffer = new StringBuilder(length);
                        if (QueryFullProcessImageName(process, 0, buffer, ref length)) {
                            string exe = buffer.ToString();
                            lock (CatalogLock) result = AppByExe.TryGetValue(exe, out cached) ? cached : exe;
                        }
                    }
                } catch (EntryPointNotFoundException) { } finally { CloseHandle(process); }
            }
            if (AppByPid.Count > 512) AppByPid.Clear();
            // An executable's id may still change once the catalog is in: only remember a final answer.
            bool final;
            lock (CatalogLock) final = AppByExe.Count > 0;
            if (final) AppByPid[pid] = result;
            return result;
        }

        static string WindowAppId(IntPtr hwnd) {
            IPropertyStore store;
            var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
            try {
                if (SHGetPropertyStoreForWindow(hwnd, ref iid, out store) != 0 || store == null) return null;
                try {
                    var key = new PROPERTYKEY { fmtid = AppUserModelKey, pid = 5 };
                    PROPVARIANT value;
                    if (store.GetValue(ref key, out value) != 0) return null;
                    try { return value.vt == 31 ? Marshal.PtrToStringUni(value.pointer) : null; }
                    finally { PropVariantClear(ref value); }
                } finally { Marshal.ReleaseComObject(store); }
            } catch { return null; }
        }

        /// <summary>
        /// Start menu apps (shell:AppsFolder): packaged apps by AppUserModelID, classic ones by
        /// `{KNOWNFOLDERID}\relative\app.exe`, which also maps their executables back to them.
        /// </summary>
        static object[] Catalog() {
            var type = Type.GetTypeFromProgID("Shell.Application");
            object shell = Activator.CreateInstance(type);
            object folder = type.InvokeMember("NameSpace", BindingFlags.InvokeMethod, null, shell, new object[] { "shell:::{4234d49b-0245-4df3-b780-3893943456e1}" });
            object items = folder.GetType().InvokeMember("Items", BindingFlags.InvokeMethod, null, folder, null);
            int count = (int)items.GetType().InvokeMember("Count", BindingFlags.GetProperty, null, items, null);
            var apps = new List<Dictionary<string, object>>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < count && i < 2000; i++) {
                object item = items.GetType().InvokeMember("Item", BindingFlags.InvokeMethod, null, items, new object[] { i });
                string name = Convert.ToString(item.GetType().InvokeMember("Name", BindingFlags.GetProperty, null, item, null));
                string id = Convert.ToString(item.GetType().InvokeMember("Path", BindingFlags.GetProperty, null, item, null));
                if (String.IsNullOrEmpty(id) || String.IsNullOrEmpty(name) || !seen.Add(id)) continue;
                // Uninstallers, help files and links to web pages are in the folder too.
                if (id.StartsWith("http", StringComparison.OrdinalIgnoreCase) || name.IndexOf("uninstall", StringComparison.OrdinalIgnoreCase) >= 0 || name.Contains("卸载")) continue;
                string exe = ResolveKnownFolder(id);
                if (exe != null && exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) lock (CatalogLock) AppByExe[exe] = id;
                else if (exe != null && !id.Contains("!")) continue;
                bool system = id.StartsWith("Microsoft.Windows", StringComparison.OrdinalIgnoreCase) || id.StartsWith("windows.", StringComparison.OrdinalIgnoreCase) || id.IndexOf("\\WINDOWS\\", StringComparison.OrdinalIgnoreCase) >= 0;
                apps.Add(new Dictionary<string, object> { { "app", id }, { "name", name }, { "category", "" }, { "system", system } });
            }
            Marshal.ReleaseComObject(shell);
            return apps.OrderBy(a => (string)a["name"], StringComparer.CurrentCulture).Cast<object>().ToArray();
        }

        static string ResolveKnownFolder(string id) {
            if (!id.StartsWith("{") || id.IndexOf('}') < 0) return null;
            Guid folder;
            if (!Guid.TryParse(id.Substring(0, id.IndexOf('}') + 1), out folder)) return null;
            IntPtr path;
            if (SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out path) != 0) return null;
            try { return Path.Combine(Marshal.PtrToStringUni(path), id.Substring(id.IndexOf('}') + 1).TrimStart('\\')); }
            finally { Marshal.FreeCoTaskMem(path); }
        }

        /// <summary>The app's own icon at 256 px, as the shell draws it (packaged or classic), PNG in base64.</summary>
        static string Icon(string app) {
            IShellItemImageFactory factory;
            var iid = new Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B");
            if (SHCreateItemFromParsingName("shell:AppsFolder\\" + app, IntPtr.Zero, ref iid, out factory) != 0 || factory == null) return null;
            IntPtr hbitmap = IntPtr.Zero;
            try {
                // SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY: an app has an icon, not a thumbnail.
                if (factory.GetImage(new SIZE { cx = 256, cy = 256 }, 0x1 | 0x4, out hbitmap) != 0 || hbitmap == IntPtr.Zero) return null;
                BITMAP info;
                GetObject(hbitmap, Marshal.SizeOf(typeof(BITMAP)), out info);
                Bitmap image;
                if (info.bmBits != IntPtr.Zero && info.bmBitsPixel == 32) {
                    // The shell's DIB keeps its alpha; Image.FromHbitmap would drop it.
                    using (var view = new Bitmap(info.bmWidth, info.bmHeight, info.bmWidthBytes, PixelFormat.Format32bppPArgb, info.bmBits)) image = new Bitmap(view);
                    image.RotateFlip(RotateFlipType.RotateNoneFlipY);
                } else image = Image.FromHbitmap(hbitmap);
                using (image)
                using (var png = new MemoryStream()) { image.Save(png, ImageFormat.Png); return Convert.ToBase64String(png.ToArray()); }
            } finally {
                if (hbitmap != IntPtr.Zero) DeleteObject(hbitmap);
                Marshal.ReleaseComObject(factory);
            }
        }

    }
}
