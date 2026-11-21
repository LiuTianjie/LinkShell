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
        [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int command);
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
        [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out PROCESS_BASIC_INFORMATION info, int size, out int returned);
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
        [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_BASIC_INFORMATION {
            public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId;
        }

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
        /// <summary>Every id the catalog lists: a window's own id is believed only when it is one of these.</summary>
        static readonly HashSet<string> CatalogIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        /// <summary>
        /// What a launched app's windows turned out to call themselves, to the app that was launched:
        /// a launcher starts another executable, a browser names its windows after a profile.
        /// </summary>
        static readonly Dictionary<string, string> AppAliases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        /// <summary>Processes already proven to belong to a fused app (so profile/follow-up windows stay its own).</summary>
        static readonly Dictionary<uint, string> FusedPids = new Dictionary<uint, string>();
        static readonly Dictionary<uint, uint> ParentPids = new Dictionary<uint, uint>();
        sealed class PendingLaunch { public DateTime At; public DateTime? FirstWindowAt; public HashSet<IntPtr> Before; public IntPtr FrontBefore; }
        /// <summary>Launches whose windows (including post-picker or post-splash follow-up windows) may still appear.</summary>
        static readonly Dictionary<string, PendingLaunch> Launches = new Dictionary<string, PendingLaunch>(StringComparer.OrdinalIgnoreCase);
        static readonly HashSet<IntPtr> SeenWindows = new HashSet<IntPtr>();
        static readonly AutoResetEvent CommandArrived = new AutoResetEvent(false);
        /// <summary>Set once the first catalog is whole: before that an executable's app is not known yet.</summary>
        static volatile bool CatalogReady;
        /// <summary>Counts catalogs: what was worked out from an older one is worked out again.</summary>
        static volatile int CatalogVersion;
        static int CatalogUsed = -1;
        static object[] CatalogResult;
        static DateTime CatalogAt;
        sealed class WindowApp { public uint Pid; public string App; public int At; }
        /// <summary>A window's app, for a moment: asking the shell for every window 30 times a second is the loop's cost.</summary>
        static readonly Dictionary<IntPtr, WindowApp> AppByWindow = new Dictionary<IntPtr, WindowApp>();
        static int PidsClearedAt = Environment.TickCount;
        const int LaunchWaitSeconds = 180;
        const int PostFirstWindowFollowUpSeconds = 30;
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
            // What was copied before the session is not the session's to send.
            ClipSeen = GetClipboardSequenceNumber();
            try { Catalog(); } catch (Exception error) { Write(new { t = "log", message = "catalog: " + error.Message }); }
            while (!ended) {
                Dictionary<string, object> request;
                // The clipboard needs an STA thread too: it is looked at between requests.
                if (!ShellRequests.TryTake(out request, 500)) { ClipboardTick(); continue; }
                object rid = request.ContainsKey("rid") ? request["rid"] : null;
                try {
                    string type = Str(request, "t");
                    if (type == "clip") SetClipboard(request);
                    // The catalog made at start answers the first session; a new one takes seconds on a slow computer.
                    else if (type == "apps") Write(new { rid = rid, apps = CatalogResult != null && (DateTime.UtcNow - CatalogAt).TotalSeconds < 60 ? CatalogResult : Catalog() });
                    else Write(new { rid = rid, png = Icon(Str(request, "app")) });
                } catch (Exception error) {
                    if (rid != null) Write(new { rid = rid, error = error.Message });
                    else Write(new { t = "log", message = "clipboard: " + error.Message });
                }
            }
        }

        [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
        /// <summary>The clipboard as last sent or written here (its sequence number). The shell thread's.</summary>
        static uint ClipSeen;
        /// <summary>A fused app's window is the foreground window: what is copied now is copied in it.</summary>
        static volatile bool FusedInFront;
        const int MaxClipboardBytes = 8 << 20;
        const long MaxFileClipboardBytes = 50L << 20;

        static List<string> FilterClipboardFiles(System.Collections.IEnumerable rawPaths) {
            var files = new List<string>();
            long totalBytes = 0;
            foreach (object item in rawPaths) {
                string path = Convert.ToString(item);
                if (String.IsNullOrEmpty(path)) continue;
                try {
                    if (!File.Exists(path)) continue;
                    long len = new FileInfo(path).Length;
                    if (len < 0 || totalBytes + len > MaxFileClipboardBytes || files.Count >= 256) return new List<string>();
                    totalBytes += len;
                    files.Add(path);
                } catch { }
            }
            return files;
        }

        /// <summary>
        /// What a fused app copied, to the host: file paths, text, or a picture (as PNG). Each change
        /// once, and only one made while a fused window is in front; a change made elsewhere waits until one is.
        /// </summary>
        static void ClipboardTick() {
            uint now = GetClipboardSequenceNumber();
            if (now == ClipSeen || !FusedInFront) return;
            ClipSeen = now;
            try {
                // Password managers mark what must not be read by clipboard watchers.
                if (System.Windows.Forms.Clipboard.ContainsData("ExcludeClipboardContentFromMonitorProcessing")) return;
                if (System.Windows.Forms.Clipboard.ContainsFileDropList()) {
                    var dropList = System.Windows.Forms.Clipboard.GetFileDropList();
                    if (dropList != null && dropList.Count > 0) {
                        var files = FilterClipboardFiles(dropList);
                        if (files.Count > 0) {
                            Write(new { t = "clip", files = files.ToArray() });
                            return;
                        }
                    }
                }
                string text = System.Windows.Forms.Clipboard.ContainsText() ? System.Windows.Forms.Clipboard.GetText() : "";
                int size = Encoding.UTF8.GetByteCount(text);
                if (size > MaxClipboardBytes) return;
                string png = null;
                if (System.Windows.Forms.Clipboard.ContainsImage()) {
                    using (var image = System.Windows.Forms.Clipboard.GetImage()) {
                        if (image != null) using (var stream = new MemoryStream()) {
                            image.Save(stream, ImageFormat.Png);
                            if (size + stream.Length <= MaxClipboardBytes) png = Convert.ToBase64String(stream.ToArray());
                        }
                    }
                }
                if (text == "" && png == null) return;
                var message = new Dictionary<string, object> { { "t", "clip" } };
                if (text != "") message["text"] = text;
                if (png != null) message["png"] = png;
                Write(message);
            } catch (Exception error) {
                // Another program holds the clipboard open: the next copy is sent.
                Write(new { t = "log", message = "clipboard: " + error.Message });
            }
        }

        static void SetClipboard(Dictionary<string, object> c) {
            object rawFiles;
            if (c.TryGetValue("files", out rawFiles) && rawFiles != null) {
                var files = FilterClipboardFiles((System.Collections.IEnumerable)rawFiles);
                if (files.Count > 0) {
                    var list = new System.Collections.Specialized.StringCollection();
                    foreach (string path in files) list.Add(path);
                    for (int attempt = 0; attempt < 5; attempt++) {
                        try { System.Windows.Forms.Clipboard.SetFileDropList(list); break; }
                        catch (ExternalException) { if (attempt == 4) throw; Thread.Sleep(100); }
                    }
                    ClipSeen = GetClipboardSequenceNumber();
                }
                return;
            }
            string text = Str(c, "text"), png = Str(c, "png");
            var data = new System.Windows.Forms.DataObject();
            MemoryStream stream = null, copy = null;
            Image image = null;
            try {
                if (text != "") data.SetData(System.Windows.Forms.DataFormats.UnicodeText, text);
                if (png != "") {
                    byte[] bytes = Convert.FromBase64String(png);
                    stream = new MemoryStream(bytes);
                    image = Image.FromStream(stream);
                    data.SetData(System.Windows.Forms.DataFormats.Bitmap, true, image);
                    // Programs that keep transparency ask for the PNG itself.
                    copy = new MemoryStream(bytes);
                    data.SetData("PNG", false, copy);
                }
                if (text == "" && png == "") return;
                System.Windows.Forms.Clipboard.SetDataObject(data, true, 5, 100);
                // What was just written is not sent back.
                ClipSeen = GetClipboardSequenceNumber();
            } finally {
                if (image != null) image.Dispose();
                if (stream != null) stream.Dispose();
                if (copy != null) copy.Dispose();
            }
        }

        static void Fusion() {
            EnsureDesktop();
            var shell = new Thread(ShellWorker) { IsBackground = true };
            shell.SetApartmentState(ApartmentState.STA);
            shell.Start();
            var reading = new System.Web.Script.Serialization.JavaScriptSerializer();
            // A copied picture is megabytes of base64; the default stops at two.
            reading.MaxJsonLength = 32 << 20; Json.MaxJsonLength = 32 << 20;
            var reader = new Thread(() => {
                try {
                    string line;
                    while ((line = Console.ReadLine()) != null) {
                        // Only a clipboard is this long: a picture, base64.
                        if (line.Length > 64000 && !(line.StartsWith("{\"t\":\"clip\"") && line.Length < (24 << 20))) continue;
                        // Its own serializer: the main loop writes with the shared one at the same time.
                        try { FusionCommands.Enqueue(reading.Deserialize<Dictionary<string, object>>(line)); CommandArrived.Set(); } catch { }
                    }
                } finally { ended = true; CommandArrived.Set(); }
            }) { IsBackground = true };
            reader.Start();
            WriteMonitors();
            string last = null;
            string lastShapeId = null;
            var sentShapes = new HashSet<string>();
            var monitorsAt = Stopwatch.StartNew();
            var scannedAt = Stopwatch.StartNew();
            var shapeAt = Stopwatch.StartNew();
            bool scanned = false;
            while (!ended) {
                Dictionary<string, object> command;
                while (FusionCommands.TryDequeue(out command)) {
                    try { FusionCommand(command); }
                    catch (Exception error) { Write(new { t = "log", message = error.Message, rid = command.ContainsKey("rid") ? command["rid"] : null }); }
                }
                // With no app fused there is nothing to find: the windows are looked at twice a
                // second, so a host that keeps this helper after a session costs next to nothing.
                bool idle;
                lock (Fused) idle = Fused.Count == 0;
                int every = idle && Launches.Count == 0 ? 500 : 33;
                // Input does not wait for the next look at the windows: it is typed as it arrives.
                if (scanned && scannedAt.ElapsedMilliseconds < every) { CommandArrived.WaitOne((int)Math.Max(1, every - scannedAt.ElapsedMilliseconds)); continue; }
                scanned = true; scannedAt.Restart();
                try {
                    EnsureDesktop();
                    var list = Json.Serialize(FusionWindowsJson());
                    if (list != last) { lock (OutputLock) { Console.Out.WriteLine("{\"t\":\"windows\",\"windows\":" + list + "}"); Console.Out.Flush(); } last = list; }
                    if (idle || !FusedInFront) {
                        lastShapeId = null;
                    } else if (shapeAt.ElapsedMilliseconds >= 200) {
                        shapeAt.Restart();
                        POINT cursorPt;
                        var screenBounds = GetCursorPos(out cursorPt)
                            ? System.Windows.Forms.Screen.FromPoint(new Point(cursorPt.X, cursorPt.Y)).Bounds
                            : System.Windows.Forms.Screen.PrimaryScreen.Bounds;
                        double scale = Math.Max(1.0, Math.Min(4.0, MonitorScale(new Point(screenBounds.Left + screenBounds.Width / 2, screenBounds.Top + screenBounds.Height / 2))));
                        var shape = CaptureCursorShape(scale);
                        if (shape != null && shape.Id != lastShapeId) {
                            lastShapeId = shape.Id;
                            Write(ShapeMessage(shape, screenBounds, scale, sentShapes.Add(shape.Id)));
                        }
                    }
                } catch (InvalidOperationException) {
                    // Locked or on the secure desktop: nothing can be captured or typed until it is back.
                    lastShapeId = null;
                    if (last != "[]") { Write(new { t = "windows", windows = new object[0] }); last = "[]"; }
                } catch (Exception error) {
                    // One window that can't be read must not end the helper and every session's windows with it.
                    Write(new { t = "log", message = "windows: " + error.Message });
                }
                if (monitorsAt.ElapsedMilliseconds > 2000) { WriteMonitors(); monitorsAt.Restart(); }
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
                case "apps": case "icon": case "clip": ShellRequests.Add(c); return;
                case "launch": {
                    string app = Str(c, "app");
                    lock (Fused) Fused.Add(app);
                    AppByWindow.Clear();
                    Launches[app] = new PendingLaunch { At = DateTime.UtcNow, Before = new HashSet<IntPtr>(SeenWindows), FrontBefore = GetForegroundWindow() };
                    try {
                        // Quoted: a classic app's id is a path, with spaces and sometimes commas.
                        Process.Start(new ProcessStartInfo("explorer.exe", "\"shell:AppsFolder\\" + app + "\"") { UseShellExecute = false });
                        Write(new { rid = rid, ok = true });
                    } catch (Exception error) { Write(new { rid = rid, ok = false, error = error.Message }); }
                    return;
                }
                case "fuse": {
                    // The whole set, the current session's: a later session starts from nothing.
                    object raw;
                    bool none;
                    lock (Fused) {
                        Fused.Clear();
                        if (c.TryGetValue("apps", out raw) && raw != null) foreach (object app in (System.Collections.IEnumerable)raw) Fused.Add(Convert.ToString(app));
                        none = Fused.Count == 0;
                    }
                    AppByWindow.Clear();
                    // What was learned at one session's launches is not the next session's.
                    if (none) { AppAliases.Clear(); FusedPids.Clear(); ParentPids.Clear(); Launches.Clear(); }
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
                    SetWindowPos(hwnd, IntPtr.Zero, 0, 0, (int)Number(c, "w") + extraW, (int)Number(c, "h") + extraH, 0x0002 | 0x0004 | 0x0010 | 0x4000);
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
            // Async: an app that is not answering must not stop every other window's input.
            if (IsIconic(hwnd)) ShowWindowAsync(hwnd, 9);
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
            int version = CatalogVersion;
            // A process id is used again by another program before long.
            if (version != CatalogUsed || unchecked(Environment.TickCount - PidsClearedAt) > 60000) {
                CatalogUsed = version; PidsClearedAt = Environment.TickCount;
                AppByPid.Clear(); AppByWindow.Clear(); ParentPids.Clear();
                foreach (uint dead in FusedPids.Keys.Where(p => !ProcessAlive(p)).ToList()) FusedPids.Remove(dead);
            }
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
                    Handle = hwnd, Pid = pid, App = AppOf(hwnd, pid, fused), Title = title.ToString(), Frame = frame,
                    Monitor = Math.Max(0, monitor), Popup = popup, Owner = owner, Minimized = IsIconic(hwnd),
                });
                return true;
            }, IntPtr.Zero);
            SeenWindows.Clear();
            foreach (var w in found) SeenWindows.Add(w.Handle);
            AdoptLaunched(found, fused);
            if (all) return found;
            var shown = found.Where(w => !w.Popup && fused.Contains(w.App)).ToList();
            foreach (var w in shown) FusedPids[w.Pid] = w.App;
            var shownPids = new HashSet<uint>(shown.Select(w => w.Pid));
            var result = new List<FusionWindow>(shown);
            foreach (var p in found.Where(w => w.Popup && shownPids.Contains(w.Pid))) {
                // A menu has no owner window: it belongs to its app's front-most window here.
                var owner = shown.FirstOrDefault(w => w.Handle == p.Owner) ?? shown.FirstOrDefault(w => w.Pid == p.Pid);
                if (owner == null) continue;
                p.Owner = owner.Handle; p.App = owner.App;
                result.Add(p);
            }
            IntPtr inFront = GetForegroundWindow();
            FusedInFront = result.Any(w => w.Handle == inFront);
            return result;
        }

        /// <summary>
        /// A launched app whose window does not carry its id: a new window from a process started
        /// by it or brought to the front (including post-picker / post-splash follow-up windows, or
        /// an already-running app whose window just came to the foreground) belongs to that app.
        /// </summary>
        static void AdoptLaunched(List<FusionWindow> found, HashSet<string> fused) {
            if (Launches.Count == 0 || !CatalogReady) return;
            DateTime now = DateTime.UtcNow;
            IntPtr front = GetForegroundWindow();
            foreach (string app in Launches.Keys.ToList()) {
                var launch = Launches[app];
                bool hasWindow = found.Any(w => !w.Popup && String.Equals(w.App, app, StringComparison.OrdinalIgnoreCase));
                if (hasWindow && !launch.FirstWindowAt.HasValue) launch.FirstWindowAt = now;
                if ((now - launch.At).TotalSeconds > LaunchWaitSeconds
                    || (launch.FirstWindowAt.HasValue && (now - launch.FirstWindowAt.Value).TotalSeconds > PostFirstWindowFollowUpSeconds)) {
                    Launches.Remove(app);
                    continue;
                }
                foreach (var w in found) {
                    if (w.Popup || w.Minimized || w.App == "" || w.Title == "" || fused.Contains(w.App)) continue;
                    if (w.Frame.Right - w.Frame.Left < 200 || w.Frame.Bottom - w.Frame.Top < 120) continue;
                    bool existedBefore = launch.Before.Contains(w.Handle);
                    // An already-running app brought to the foreground right after `launch` had its
                    // window in `Before`: adopt it if this launch just raised it to the front.
                    if (existedBefore) {
                        if (hasWindow || w.Handle != front || w.Handle == launch.FrontBefore || (now - launch.At).TotalSeconds > 10) continue;
                    } else if (w.Handle != front && !StartedSince(w.Pid, launch.At)) {
                        continue;
                    }
                    bool known;
                    lock (CatalogLock) known = CatalogIds.Contains(w.App);
                    if (known && !existedBefore) {
                        // A browser's PWA shortcut may share chrome.exe in the catalog while the
                        // user launched Chrome itself: only skip when no prefix ties them together.
                        if (!w.App.StartsWith(app + ".", StringComparison.OrdinalIgnoreCase)) continue;
                    }
                    if (!known) AppAliases[w.App] = app;
                    FusedPids[w.Pid] = app;
                    AppByWindow.Clear();
                    Write(new { t = "log", message = "fusion: windows of " + w.App + " (pid " + w.Pid + ") belong to " + app });
                    string was = w.App;
                    foreach (var other in found) {
                        if (other.Pid == w.Pid || (!known && String.Equals(other.App, was, StringComparison.OrdinalIgnoreCase))) other.App = app;
                    }
                    if (!launch.FirstWindowAt.HasValue) launch.FirstWindowAt = now;
                    break;
                }
            }
        }

        static bool ProcessAlive(uint pid) {
            try { using (var process = Process.GetProcessById((int)pid)) return !process.HasExited; }
            catch { return false; }
        }

        static bool StartedSince(uint pid, DateTime at) {
            try { using (var process = Process.GetProcessById((int)pid)) return process.StartTime.ToUniversalTime() >= at.AddSeconds(-2); }
            catch { return false; }
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

        /// <summary>
        /// The catalog's id for a window: an explicitly fused window id or process tree wins first
        /// (so Chrome's profile window stays under `Chrome` after its Profile Picker closes), then
        /// the catalog's own entry or executable map, else whatever was learned at launch.
        /// </summary>
        static string AppOf(IntPtr hwnd, uint pid, HashSet<string> fused) {
            WindowApp known;
            int now = Environment.TickCount;
            if (AppByWindow.TryGetValue(hwnd, out known) && known.Pid == pid && unchecked(now - known.At) < 1500) return known.App;
            string app = AppOfNow(hwnd, pid, fused);
            if (AppByWindow.Count > 1024) AppByWindow.Clear();
            AppByWindow[hwnd] = new WindowApp { Pid = pid, App = app, At = now };
            return app;
        }

        static string AppOfNow(IntPtr hwnd, uint pid, HashSet<string> fused) {
            string id = WindowAppId(hwnd);
            string proc = ProcessApp(pid);
            string pidOwner = FusedOwnerOfPid(pid, fused);
            lock (CatalogLock) {
                return ResolveWindowApp(id, proc, pidOwner, fused, CatalogIds, AppAliases);
            }
        }

        internal static string ResolveWindowApp(string windowId, string processApp, string pidOwner, HashSet<string> fused, HashSet<string> catalogIds, Dictionary<string, string> aliases) {
            string alias;
            if (!String.IsNullOrEmpty(windowId)) {
                if (fused.Contains(windowId)) return windowId;
                if (aliases.TryGetValue(windowId, out alias) && fused.Contains(alias)) return alias;
            }
            if (!String.IsNullOrEmpty(pidOwner) && fused.Contains(pidOwner)) {
                // Keep follow-up windows of a fused process (e.g. `Chrome.<ProfileHash>`) with that
                // app unless the window carries a distinct unrelated catalog id.
                bool unrelatedListed = !String.IsNullOrEmpty(windowId) && catalogIds.Contains(windowId)
                    && !windowId.StartsWith(pidOwner + ".", StringComparison.OrdinalIgnoreCase);
                if (!unrelatedListed) return pidOwner;
            }
            if (!String.IsNullOrEmpty(windowId)) {
                int dot = windowId.IndexOf('.');
                if (dot > 0 && windowId.IndexOf("_crx_", StringComparison.OrdinalIgnoreCase) < 0) {
                    string prefix = windowId.Substring(0, dot);
                    if (fused.Contains(prefix)) return prefix;
                }
                if (catalogIds.Contains(windowId)) return windowId;
            }
            if (!String.IsNullOrEmpty(processApp)) {
                if (fused.Contains(processApp)) return processApp;
                if (aliases.TryGetValue(processApp, out alias) && fused.Contains(alias)) return alias;
                if (catalogIds.Contains(processApp)) return processApp;
            }
            string result = !String.IsNullOrEmpty(windowId) ? windowId : (processApp ?? "");
            if (aliases.TryGetValue(result, out alias)) return alias;
            if (!String.IsNullOrEmpty(windowId)) {
                int dot = windowId.IndexOf('.');
                if (dot > 0 && windowId.IndexOf("_crx_", StringComparison.OrdinalIgnoreCase) < 0) {
                    string prefix = windowId.Substring(0, dot);
                    if (catalogIds.Contains(prefix)) return prefix;
                }
            }
            return result;
        }

        static string FusedOwnerOfPid(uint pid, HashSet<string> fused) {
            uint current = pid;
            for (int depth = 0; depth < 3 && current != 0; depth++) {
                string owner;
                if (FusedPids.TryGetValue(current, out owner) && fused.Contains(owner)) return owner;
                uint parent;
                if (!ParentPids.TryGetValue(current, out parent)) {
                    parent = QueryParentPid(current);
                    if (ParentPids.Count > 512) ParentPids.Clear();
                    ParentPids[current] = parent;
                }
                if (parent == 0 || parent == current) break;
                current = parent;
            }
            return null;
        }

        static uint QueryParentPid(uint pid) {
            IntPtr process = OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) return 0;
            try {
                PROCESS_BASIC_INFORMATION info;
                int returned;
                if (NtQueryInformationProcess(process, 0, out info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned) != 0) return 0;
                long parent = info.InheritedFromUniqueProcessId.ToInt64();
                return parent > 0 && parent <= uint.MaxValue ? (uint)parent : 0;
            } catch { return 0; } finally { CloseHandle(process); }
        }

        static bool IsOwnLinkShellEntry(string id, string targetExe) {
            if (String.IsNullOrEmpty(id)) return true;
            if (id.StartsWith("LinkShell.", StringComparison.OrdinalIgnoreCase) || id.StartsWith("com.bd.linkshell.", StringComparison.OrdinalIgnoreCase)) return true;
            string check = !String.IsNullOrEmpty(targetExe) ? targetExe : id;
            return check.EndsWith("\\LinkShell.exe", StringComparison.OrdinalIgnoreCase)
                || check.EndsWith("\\LinkShell.Screen.exe", StringComparison.OrdinalIgnoreCase);
        }

        static string ProcessApp(uint pid) {
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
            if (CatalogReady) AppByPid[pid] = result;
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
            // Built apart and put in place whole: the window loop reads these all the while, and a
            // half-made catalog would name a running app by its executable for good.
            var byExe = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var primaryExes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < count && i < 2000; i++) {
                object item = items.GetType().InvokeMember("Item", BindingFlags.InvokeMethod, null, items, new object[] { i });
                string name = Convert.ToString(item.GetType().InvokeMember("Name", BindingFlags.GetProperty, null, item, null));
                string id = Convert.ToString(item.GetType().InvokeMember("Path", BindingFlags.GetProperty, null, item, null));
                if (String.IsNullOrEmpty(id) || String.IsNullOrEmpty(name) || !seen.Add(id)) continue;
                // Uninstallers, help files, links to web pages, and LinkShell itself (or its own Fusion shortcuts) are excluded.
                if (id.StartsWith("http", StringComparison.OrdinalIgnoreCase) || name.IndexOf("uninstall", StringComparison.OrdinalIgnoreCase) >= 0 || name.Contains("卸载")) continue;
                string exe = ResolveKnownFolder(id);
                if (IsOwnLinkShellEntry(id, exe)) continue;
                if (exe != null && exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) { byExe[exe] = id; primaryExes.Add(exe); }
                else if (exe != null && !id.Contains("!")) continue;
                // A shortcut with an id of its own (most installers write one): the executable it
                // starts is the only thing its windows have in common with it. A plain shortcut
                // (Google Chrome) wins over argument-bearing PWA shortcuts (`--app-id=...`).
                if (exe == null && !id.Contains("!")) {
                    string target = null, args = null;
                    try { target = Convert.ToString(item.GetType().InvokeMember("ExtendedProperty", BindingFlags.InvokeMethod, null, item, new object[] { "System.Link.TargetParsingPath" })); } catch { }
                    try { args = Convert.ToString(item.GetType().InvokeMember("ExtendedProperty", BindingFlags.InvokeMethod, null, item, new object[] { "System.Link.Arguments" })); } catch { }
                    if (String.IsNullOrEmpty(target) && id.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && Path.IsPathRooted(id)) target = id;
                    if (String.IsNullOrEmpty(target)) target = ResolveAppPathRegistry(id);
                    if (IsOwnLinkShellEntry(id, target)) continue;
                    if (!String.IsNullOrEmpty(target) && target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) {
                        bool primary = String.IsNullOrEmpty(args) && id.IndexOf("_crx_", StringComparison.OrdinalIgnoreCase) < 0;
                        if (primary && !primaryExes.Contains(target)) { byExe[target] = id; primaryExes.Add(target); }
                        else if (!byExe.ContainsKey(target)) byExe[target] = id;
                    }
                }
                ids.Add(id);
                bool system = id.StartsWith("Microsoft.Windows", StringComparison.OrdinalIgnoreCase) || id.StartsWith("windows.", StringComparison.OrdinalIgnoreCase) || id.IndexOf("\\WINDOWS\\", StringComparison.OrdinalIgnoreCase) >= 0;
                apps.Add(new Dictionary<string, object> { { "app", id }, { "name", name }, { "category", "" }, { "system", system } });
            }
            Marshal.ReleaseComObject(shell);
            lock (CatalogLock) {
                AppByExe.Clear(); foreach (var pair in byExe) AppByExe[pair.Key] = pair.Value;
                CatalogIds.Clear(); foreach (string listed in ids) CatalogIds.Add(listed);
            }
            CatalogReady = true;
            CatalogVersion = CatalogVersion + 1;
            CatalogResult = apps.OrderBy(a => (string)a["name"], StringComparer.CurrentCulture).Cast<object>().ToArray();
            CatalogAt = DateTime.UtcNow;
            return CatalogResult;
        }

        /// <summary>Virtual AppsFolder entries registered via RegisteredApplications (`Chrome`, `MSEdge`) have no `.lnk` target; `App Paths` names their executable.</summary>
        static string ResolveAppPathRegistry(string id) {
            if (String.IsNullOrEmpty(id) || id.IndexOf('\\') >= 0 || id.IndexOf('/') >= 0) return null;
            string leaf = id.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? id : id + ".exe";
            string subkey = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + leaf;
            foreach (var root in new[] { Microsoft.Win32.Registry.CurrentUser, Microsoft.Win32.Registry.LocalMachine }) {
                try {
                    using (var key = root.OpenSubKey(subkey)) {
                        if (key == null) continue;
                        string val = Convert.ToString(key.GetValue(null));
                        if (!String.IsNullOrEmpty(val)) {
                            val = val.Trim('\"');
                            if (val.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(val)) return val;
                        }
                    }
                } catch { }
            }
            return null;
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
