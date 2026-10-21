using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace LinkShell.Windows {
    // Match DesktopView.swift's information hierarchy and theme; keep platform actions native.
    internal sealed class Dashboard : Window {
        readonly bool hidden, preview;
        readonly Grid root = new Grid();
        readonly Grid shell = new Grid();
        Workspace workspace;
        bool management, exiting;
        DateTime lastAccountRefresh = DateTime.MinValue;
        readonly StackPanel content = new StackPanel();
        readonly ScrollViewer scroll = new ScrollViewer();
        readonly StackPanel navigation = new StackPanel();
        readonly TextBlock title = new TextBlock(), subtitle = new TextBlock(), footer = new TextBlock();
        readonly Border noticeBox = new Border(), overlay = new Border();
        readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        readonly DispatcherTimer seconds = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        readonly List<Tuple<DateTime, string>> activity = new List<Tuple<DateTime, string>>();
        readonly List<TextBlock> countdowns = new List<TextBlock>();
        readonly Dictionary<string, Button> navButtons = new Dictionary<string, Button>();
        readonly Forms.NotifyIcon tray;
        Dictionary<string, object> snapshot, report, offer;
        object[] usageAgents = new object[0];
        HashSet<string> initialDevices = new HashSet<string>();
        string selected = "总览", appearance = "dark", notice = "", statusError = "", loginMessage = "", usageError = "", updateMessage = "尚未检查更新", updateUrl;
        string agent = "all", snapshotJson = "";
        int days = 7, usageGeneration;
        bool busy, polling, signingIn, pairing, paired, usageLoading, checking, quitting, dark = true;
        Process login, accountAction;
        Window trayPanel;
        Button serviceMenuButton;
        Popup servicePopup;
        DateTime pairExpiry = DateTime.MinValue;
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        public Dashboard(bool startHidden, bool designPreview = false) {
            hidden = startHidden; preview = designPreview;
            Title = preview ? "LinkShell · 设计预览" : "LinkShell";
            Width = 1040; Height = 790; MinWidth = 880; MinHeight = 650;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            FontFamily = new FontFamily("Segoe UI, Microsoft YaHei UI"); FontSize = 13;
            UseLayoutRounding = true; SnapsToDevicePixels = true;
            using (var stream = Resource("DesktopTheme.xaml")) Resources.MergedDictionaries.Add((ResourceDictionary)XamlReader.Load(stream));
            Icon = Asset("brand.png");
            try {
                string path = System.IO.Path.Combine(Desktop.Home, "desktop-preferences.json");
                if (!preview && File.Exists(path)) {
                    string saved = Desktop.Text(Desktop.Json.DeserializeObject(File.ReadAllText(path)), "appearance");
                    if (new[] { "dark", "light", "system" }.Contains(saved)) appearance = saved;
                }
            } catch { notice = "无法读取外观偏好，已使用默认深色。"; }
            SetResourceReference(BackgroundProperty, "Background"); SetResourceReference(ForegroundProperty, "Primary");
            BuildShell(); ApplyAppearance();
            tray = new Forms.NotifyIcon { Text = "LinkShell", Visible = !preview, Icon = System.Drawing.Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location) };
            tray.MouseUp += (s, e) => Dispatcher.Invoke(new Action(ToggleTray));
            Closing += (s, e) => { if (!quitting) { e.Cancel = true; Hide(); } };
            Closed += (s, e) => { timer.Stop(); seconds.Stop(); CancelLogin(); if (workspace != null) workspace.Dispose(); tray.Dispose(); SystemEvents.UserPreferenceChanged -= SystemPreferenceChanged; };
            IsVisibleChanged += async (s, e) => await SyncWorkspace();
            StateChanged += async (s, e) => await SyncWorkspace();
            PreviewKeyDown += (s, e) => { if (management && Keyboard.Modifiers == ModifierKeys.Control && (e.Key == Key.D1 || e.Key == Key.D2)) { ShowMode(e.Key == Key.D2); e.Handled = true; } };
            SourceInitialized += (s, e) => SetTitlebar();
            SystemEvents.UserPreferenceChanged += SystemPreferenceChanged;
            timer.Tick += async (s, e) => { if (!preview && !busy) await RefreshStatus(); };
            seconds.Tick += (s, e) => UpdateCountdown();
            Loaded += async (s, e) => {
                if (hidden) Hide();
                if (preview) { LoadPreview(); Render(); return; }
                Render();
                busy = true;
                try {
                    await Run("recover-update");
                    await RefreshStatus();
                    if (Desktop.Text(snapshot, "status") == "stopped") { await Run("start"); await RefreshStatus(); }
                } catch (Exception error) { notice = "后台服务启动失败：" + error.Message; }
                finally { busy = false; Render(); timer.Start(); seconds.Start(); }
                await workspace.Start();
                await SyncWorkspace();
            };
        }

        static Stream Resource(string name) { return Assembly.GetExecutingAssembly().GetManifestResourceStream(name); }
        static ImageSource Asset(string name) {
            using (var stream = Resource(name)) {
                if (stream == null) return null;
                var image = new BitmapImage(); image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad; image.StreamSource = stream; image.EndInit(); image.Freeze(); return image;
            }
        }
        Brush Brush(string key) { return (Brush)FindResource(key); }
        void ColorResource(string key, string hex) { Resources[key] = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex)); }
        void ApplyAppearance() {
            dark = appearance != "light";
            if (appearance == "system") {
                using (var key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")) dark = key == null || Convert.ToInt32(key.GetValue("AppsUseLightTheme", 0)) == 0;
            }
            string[] keys = { "Background", "Sidebar", "Primary", "Secondary", "Accent", "OnAccent", "Line", "Selection", "Warning" };
            string[] colors = dark ? new[] { "#060709", "#0B0C0F", "#F0F1F3", "#A8ADB5", "#3DE0BF", "#060709", "#24262A", "#1B1D21", "#F3B66B" }
                : new[] { "#FAFAFB", "#F1F2F5", "#1F2129", "#616670", "#0A755C", "#FFFFFF", "#E0E1E5", "#EDEEF0", "#946019" };
            for (int i = 0; i < keys.Length; i++) ColorResource(keys[i], colors[i]);
            SetTitlebar();
            if (workspace != null) { var update = SyncWorkspace(); }
            if (trayPanel != null) trayPanel.Close();
        }
        void SetTitlebar() { var hwnd = new WindowInteropHelper(this).Handle; if (hwnd != IntPtr.Zero) { int value = dark ? 1 : 0; try { DwmSetWindowAttribute(hwnd, 20, ref value, 4); } catch (DllNotFoundException) {} } }
        void SystemPreferenceChanged(object sender, UserPreferenceChangedEventArgs e) { if (appearance == "system") Dispatcher.BeginInvoke(new Action(() => { ApplyAppearance(); Render(); })); }
        void SaveAppearance(string value) {
            try {
                if (!preview) File.WriteAllText(System.IO.Path.Combine(Desktop.Home, "desktop-preferences.json"), Desktop.Json.Serialize(new { appearance = value }));
                appearance = value; ApplyAppearance(); Render();
            } catch (Exception error) { ShowError(error); }
        }

        TextBlock Text(string value, double size = 13, string tone = "Primary", bool bold = false) {
            var label = new TextBlock { Text = value ?? "", FontSize = size, FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal, VerticalAlignment = VerticalAlignment.Center };
            label.SetResourceReference(TextBlock.ForegroundProperty, tone); return label;
        }
        TextBlock Glyph(string glyph, double size = 18, string tone = "Secondary") {
            var label = Text(glyph, size, tone); label.FontFamily = new FontFamily("Segoe MDL2 Assets"); return label;
        }
        Border Rule(double top = 0, double bottom = 0) { var rule = new Border { Height = 1, Margin = new Thickness(0, top, 0, bottom) }; rule.SetResourceReference(Border.BackgroundProperty, "Line"); return rule; }
        StackPanel Stack(params UIElement[] children) { var stack = new StackPanel(); foreach (var child in children) stack.Children.Add(child); return stack; }
        Grid Split(UIElement left, UIElement right, double gap = 16) {
            var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var first = new Border { Child = left, Margin = new Thickness(0, 0, gap, 0), VerticalAlignment = VerticalAlignment.Center };
            grid.Children.Add(first); Grid.SetColumn(right, 1); grid.Children.Add(right); return grid;
        }
        Button Button(string caption, Action action, bool accent = false, bool quiet = false) {
            var button = new Button { Content = caption, VerticalAlignment = VerticalAlignment.Center };
            AutomationProperties.SetName(button, caption);
            if (accent) { button.SetResourceReference(BackgroundProperty, "Accent"); button.SetResourceReference(ForegroundProperty, "OnAccent"); button.BorderThickness = new Thickness(0); button.FontWeight = FontWeights.SemiBold; }
            if (quiet) { button.Background = Brushes.Transparent; button.BorderThickness = new Thickness(0); button.SetResourceReference(ForegroundProperty, "Secondary"); button.Padding = new Thickness(4, 6, 4, 6); }
            button.Click += (s, e) => { try { action(); } catch (Exception error) { ShowError(error); } }; return button;
        }
        Border Card(UIElement child, double padding = 20) { var card = new Border { Child = child, Padding = new Thickness(padding), CornerRadius = new CornerRadius(12) }; card.SetResourceReference(Border.BackgroundProperty, "Selection"); return card; }
        UIElement Status(string value, string tone = "Secondary") {
            var panel = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            var dot = new Ellipse { Width = 7, Height = 7, Margin = new Thickness(0, 0, 9, 0), VerticalAlignment = VerticalAlignment.Center }; dot.SetResourceReference(Shape.FillProperty, tone);
            panel.Children.Add(dot); panel.Children.Add(Text(value, 13, "Secondary")); return panel;
        }
        void Row(Panel parent, string label, UIElement value, string detail = null) {
            var left = Stack(Text(label, 14));
            if (detail != null) { var note = Text(detail, 12, "Secondary"); note.Margin = new Thickness(0, 7, 0, 0); left.Children.Add(note); }
            var row = Split(left, value); row.Margin = new Thickness(0, 18, 0, 18); parent.Children.Add(row); parent.Children.Add(Rule());
        }
        void Heading(Panel parent, string value, UIElement action = null) {
            UIElement heading = action == null ? (UIElement)Text(value, 19, "Primary", true) : Split(Text(value, 19, "Primary", true), action);
            ((FrameworkElement)heading).Margin = new Thickness(0, 28, 0, 16); parent.Children.Add(heading);
        }
        void Empty(Panel parent, string heading, string detail, string icon = "\uE8BD") {
            var symbol = Glyph(icon, 25); symbol.Margin = new Thickness(0, 0, 0, 14);
            var lead = Text(heading, 14); lead.Margin = new Thickness(0, 0, 0, 7);
            var block = Stack(symbol, lead, Text(detail, 12, "Secondary")); block.Margin = new Thickness(0, 22, 0, 22); parent.Children.Add(block);
        }
        bool Healthy { get { return Desktop.Text(snapshot, "status") == "running"; } }
        string ServiceLabel { get { string s = Desktop.Text(snapshot, "status"); return s == "running" ? "运行中" : s == "stopped" ? "已停止" : snapshot == null ? "正在连接" : "无法连接"; } }
        string GatewayLabel { get { if (!Healthy) return "未知"; string s = Desktop.Text(Desktop.Get(snapshot, "gateway"), "status"); return s == "online" ? "已连接" : s == "off" ? "未启用" : s == "connecting" ? "连接中" : "已断开"; } }
        bool SignedIn { get { return Desktop.Text(Desktop.Get(snapshot, "account"), "state") == "signed-in"; } }
        IEnumerable<object> Sessions { get { return Desktop.Items(Desktop.Get(snapshot, "sessions")); } }
        IEnumerable<object> Devices { get { return Desktop.Items(Desktop.Get(Desktop.Get(snapshot, "gateway"), "devices")); } }
        static bool Yes(object data, string key) { return Desktop.Get(data, key) is bool && (bool)Desktop.Get(data, key); }
        static double Number(object data, string key) { object value = Desktop.Get(data, key); return value == null ? 0 : Convert.ToDouble(value, CultureInfo.InvariantCulture); }
        static string Compact(double value) { return value >= 1e9 ? (value / 1e9).ToString("0.#") + "B" : value >= 1e6 ? (value / 1e6).ToString("0.#") + "M" : value >= 1e3 ? (value / 1e3).ToString("0.#") + "K" : value.ToString("N0"); }

        void BuildShell() {
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(232) }); root.ColumnDefinitions.Add(new ColumnDefinition());
            var sidebar = new Grid { Margin = new Thickness(0) }; sidebar.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); sidebar.RowDefinitions.Add(new RowDefinition()); sidebar.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            sidebar.SetResourceReference(Panel.BackgroundProperty, "Sidebar");
            var brand = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 14) };
            brand.Children.Add(new Image { Source = Asset("brand.png"), Width = 30, Height = 30, Margin = new Thickness(0, 0, 10, 0) }); brand.Children.Add(Text("LinkShell", 17, "Primary", true));
            var modes = new UniformGrid { Columns = 2, Height = 34 };
            var work = Button("工作台", () => ShowMode(false), false, true); work.ToolTip = "Ctrl+1"; modes.Children.Add(work);
            var manage = Button("本机管理", () => ShowMode(true)); manage.ToolTip = "Ctrl+2"; manage.Padding = new Thickness(0); manage.FontWeight = FontWeights.SemiBold; modes.Children.Add(manage);
            sidebar.Children.Add(new Border { Height = 104, Padding = new Thickness(14, 14, 14, 12), Child = Stack(brand, modes) });
            navigation.Margin = new Thickness(10, 0, 10, 0); Grid.SetRow(navigation, 1); sidebar.Children.Add(navigation);
            string[] names = { "总览", "设备", "用量统计", "日志", "更新", "设置" };
            string[] icons = { "\uE80F", "\uE772", "\uE9D2", "\uE9D9", "\uE896", "\uE713" };
            var lower = new StackPanel { Margin = new Thickness(10, 0, 10, 20) }; lower.Children.Add(Rule(0, 12)); Grid.SetRow(lower, 2); sidebar.Children.Add(lower);
            for (int i = 0; i < names.Length; i++) {
                string page = names[i]; var button = Button(page, () => Navigate(page));
                var row = new StackPanel { Orientation = Orientation.Horizontal }; var icon = Glyph(icons[i], 17); icon.Width = 22; icon.Margin = new Thickness(0, 0, 13, 0); row.Children.Add(icon); row.Children.Add(Text(page, 14));
                button.Content = row; button.HorizontalContentAlignment = HorizontalAlignment.Left; button.Height = 42; button.Padding = new Thickness(14, 0, 10, 0); button.Margin = new Thickness(0, 0, 0, 5); button.BorderThickness = new Thickness(1); button.BorderBrush = Brushes.Transparent;
                navButtons[page] = button; if (i < 4) navigation.Children.Add(button); else lower.Children.Add(button);
            }
            if (preview) { lower.Children.Add(Button("预览托盘", ToggleTray, false, true)); lower.Children.Add(Text("设计预览 · 示例数据", 10, "Secondary")); }
            root.Children.Add(sidebar);
            var main = new Grid { Margin = new Thickness(36, 30, 36, 24) }; main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); main.RowDefinitions.Add(new RowDefinition()); main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); Grid.SetColumn(main, 1); root.Children.Add(main);
            title.FontSize = 28; title.FontWeight = FontWeights.SemiBold; title.SetResourceReference(TextBlock.ForegroundProperty, "Primary"); subtitle.FontSize = 13; subtitle.Margin = new Thickness(0, 7, 0, 0); subtitle.SetResourceReference(TextBlock.ForegroundProperty, "Secondary");
            var menu = Button("服务操作", ShowServiceMenu); menu.Content = Glyph("\uE712", 20); menu.Width = 36; menu.Height = 32; menu.Padding = new Thickness(0); menu.ToolTip = "服务操作";
            serviceMenuButton = menu;
            var header = Split(Stack(title, subtitle), menu); header.Margin = new Thickness(0, 0, 0, 26); main.Children.Add(header);
            noticeBox.CornerRadius = new CornerRadius(7); noticeBox.Padding = new Thickness(12); noticeBox.Margin = new Thickness(0, 0, 0, 16); noticeBox.SetResourceReference(Border.BackgroundProperty, "Selection"); Grid.SetRow(noticeBox, 1); main.Children.Add(noticeBox);
            scroll.Content = content; scroll.Padding = new Thickness(0, 0, 8, 0); Grid.SetRow(scroll, 2); main.Children.Add(scroll);
            footer.FontSize = 12; footer.SetResourceReference(TextBlock.ForegroundProperty, "Secondary");
            var foot = Stack(Rule(18, 14), Split(footer, Button("检查更新", () => { Navigate("更新"); CheckUpdates(); }, false, true))); Grid.SetRow(foot, 3); main.Children.Add(foot);
            overlay.Background = new SolidColorBrush(Color.FromArgb(160, 0, 0, 0)); overlay.Visibility = Visibility.Collapsed; Grid.SetColumnSpan(overlay, 2); Panel.SetZIndex(overlay, 10); root.Children.Add(overlay);
            overlay.PreviewKeyDown += (s, e) => { if (e.Key == Key.Escape) { CloseDialog(); e.Handled = true; } };
            workspace = new Workspace(() => ShowMode(true), SaveAppearance);
            shell.Children.Add(workspace); shell.Children.Add(root); Content = shell;
            ShowMode(preview);
        }
        void ShowMode(bool value) {
            management = value; root.Visibility = value ? Visibility.Visible : Visibility.Collapsed;
            workspace.Visibility = value ? Visibility.Hidden : Visibility.Visible;
            var update = SyncWorkspace();
        }
        Task SyncWorkspace() { return workspace == null ? Task.FromResult(0) : workspace.SetState(!management && IsVisible && WindowState != WindowState.Minimized, appearance); }
        void Navigate(string page) {
            if (page == "会话" || page == "工作台") { ShowMode(false); return; }
            ShowMode(true);
            selected = page; scroll.ScrollToTop(); Render();
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(scroll.ScrollToTop));
            if (page == "用量统计" && report == null && !usageLoading) LoadUsage();
        }
        void Render() {
            if (quitting) return;
            double offset = scroll.VerticalOffset;
            title.Text = selected == "总览" ? "这台电脑" : selected;
            subtitle.Text = selected == "总览" ? (Healthy ? "LinkShell 正在后台运行" : "本机服务" + ServiceLabel) : selected == "会话" ? "当前 Host 中的会话与待处理请求" : selected == "设备" ? "与这台电脑配对的设备" : selected == "用量统计" ? "这台电脑的 Token 用量与模型分布" : selected == "日志" ? "Host 最近 64 KB 日志 · 每 5 秒刷新" : selected == "更新" ? "检查版本与管理现有安装" : "本机权限与应用偏好";
            foreach (var entry in navButtons) entry.Value.Background = entry.Key == selected ? Brush("Selection") : Brushes.Transparent;
            footer.Text = preview ? "设计预览 · 示例数据" : busy ? "正在处理，请稍候…" : "服务" + ServiceLabel + " · 网关" + GatewayLabel;
            string message = statusError.Length > 0 ? statusError : notice;
            noticeBox.Visibility = String.IsNullOrEmpty(message) ? Visibility.Collapsed : Visibility.Visible;
            noticeBox.Child = Split(Text(message, 12, "Warning"), Button("重试", async () => { notice = ""; await RefreshStatus(); Render(); }, false, true));
            content.Children.Clear(); countdowns.Clear();
            switch (selected) {
                case "会话": SessionTable(content, Sessions); if (Yes(snapshot, "hasMoreSessions")) content.Children.Add(Text("显示最近 200 个会话。更多历史可在手机端查看。", 12, "Secondary")); break;
                case "设备": DevicesPage(); break;
                case "用量统计": UsagePage(); break;
                case "日志": LogsPage(); break;
                case "更新": UpdatesPage(); break;
                case "设置": SettingsPage(); break;
                default: Overview(); break;
            }
            UpdateCountdown();
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() => scroll.ScrollToVerticalOffset(offset)));
            if (!preview) tray.Text = "LinkShell · " + ServiceLabel;
        }
        void Overview() {
            AccountSection(content); PairingSection(content);
            if (Desktop.Text(snapshot, "status") == "stopped") {
                var start = Button("启动服务", async () => await Perform("start"), true); start.IsEnabled = !busy && !preview;
                var row = Split(Text("启动后台服务后，即可从手机连接这台电脑。", 12, "Secondary"), start); row.Margin = new Thickness(0, 8, 0, 8); content.Children.Add(row);
            }
            if (!preview && Healthy && !String.Equals(Desktop.Text(snapshot, "hostOwner"), Desktop.Root, StringComparison.OrdinalIgnoreCase)) {
                var row = Split(Text("当前服务由另一套 CLI 启动", 12, "Warning"), Button("切换到内置服务…", () => ConfirmAction("restart"), false, true)); row.Margin = new Thickness(0, 8, 0, 0); content.Children.Add(row);
            }
            Row(content, "本机服务", Status(ServiceLabel, Healthy ? "Accent" : "Secondary"));
            Row(content, "网关连接", Status(GatewayLabel, GatewayLabel == "已连接" ? "Accent" : "Secondary"));
            var access = Desktop.Get(snapshot, "screen"); bool allowed = !File.Exists(System.IO.Path.Combine(Desktop.Home, "windows-screen-disabled"));
            bool ready = Healthy && Yes(access, "recording") && Yes(access, "control");
            var screen = Button("屏幕与控制设置", () => Navigate("设置"), false, true); screen.Content = Status(!allowed ? "已关闭" : ready ? "已就绪" : snapshot == null ? "检查中" : "需要检查", ready ? "Accent" : "Warning");
            Row(content, "屏幕与控制", screen);
            Heading(content, "会话  " + Sessions.Count(), Button("查看全部", () => Navigate("会话"), false, true)); SessionTable(content, Sessions.Take(4));
            Heading(content, "最近活动");
            if (activity.Count == 0) Empty(content, "尚无活动", "连接服务后，状态变化会显示在这里。", "\uE787");
            foreach (var entry in activity.Take(4)) { var row = Split(Text(entry.Item2, 13, "Secondary"), Text(entry.Item1.ToString("HH:mm"), 12, "Secondary")); row.Margin = new Thickness(0, 0, 0, 12); content.Children.Add(row); }
        }
        void AccountSection(Panel parent) {
            var heading = Text("LinkShell 账号", 14, "Primary", true); heading.Margin = new Thickness(0, 0, 0, 6);
            string account = SignedIn ? Desktop.Text(Desktop.Get(snapshot, "account"), "email") : "登录后，在手机上使用同一账号连接这台电脑。";
            var description = Text(account, 12, "Secondary"); description.ToolTip = account;
            var loginButton = Button(signingIn ? "取消登录" : SignedIn ? "退出登录…" : "登录 / 注册", () => { if (signingIn) CancelLogin(); else if (SignedIn) ConfirmAction("logout"); else Login(); }, !SignedIn && !signingIn);
            loginButton.IsEnabled = !preview && (!busy || signingIn);
            var row = Split(Stack(heading, description), loginButton); row.Margin = new Thickness(0, 5, 0, 12); parent.Children.Add(row);
            if (!String.IsNullOrEmpty(loginMessage)) { var message = Text(loginMessage, 12, "Secondary"); message.Margin = new Thickness(0, 0, 0, 10); parent.Children.Add(message); }
            if (SignedIn) {
                var member = Desktop.Get(snapshot, "account"); string plan = Desktop.Text(member, "plan");
                string membership = plan == "pro" ? "Pro 会员" : plan == "free" ? "免费账号" : "会员状态待刷新";
                DateTime expiry;
                if (plan == "pro" && DateTime.TryParse(Desktop.Text(member, "planExpiresAt"), out expiry)) membership += " · 有效期至 " + expiry.ToLocalTime().ToString("yyyy-MM-dd");
                var refresh = Button("刷新会员", RefreshAccount, false, true); refresh.IsEnabled = !busy && !preview;
                parent.Children.Add(Split(Text(membership, 12, plan == "pro" ? "Accent" : "Secondary"), refresh));
                var redeem = Button("兑换 Pro 激活码…", Redeem, false, true); redeem.IsEnabled = !busy && !preview; parent.Children.Add(redeem);
                var connect = Button("连接官方网关…", () => ConfirmAction("connect-gateway"), false, true); connect.IsEnabled = !preview && !busy; connect.Visibility = GatewayLabel == "已连接" ? Visibility.Collapsed : Visibility.Visible;
                parent.Children.Add(Split(Text("网关：" + GatewayLabel, 12, "Secondary"), connect));
            } else parent.Children.Add(Text("官方网关需要 Pro；自建网关仍可通过配对使用。", 11, "Secondary"));
            parent.Children.Add(Rule(20, 20));
        }
        void PairingSection(Panel parent) {
            var icon = Glyph("\uED14", 27, "Accent"); icon.Margin = new Thickness(0, 0, 16, 0);
            var heading = Text("连接你的手机", 16, "Primary", true); heading.Margin = new Thickness(0, 0, 0, 6);
            var titleRow = new DockPanel(); DockPanel.SetDock(icon, Dock.Left); titleRow.Children.Add(icon); titleRow.Children.Add(Stack(heading, Text("扫描二维码或输入配对码，添加这台电脑", 12, "Secondary")));
            var button = Button(pairing ? "正在生成…" : offer == null ? "配对新设备" : "重新生成", Pair); button.IsEnabled = !pairing && !busy && !preview;
            var panel = Stack(Split(titleRow, button));
            var detail = Text(paired ? "设备已配对" : "同账号登录可自动发现；设备配对独立于账号。", 11, paired ? "Accent" : "Secondary"); detail.Margin = new Thickness(0, 16, 0, 0); panel.Children.Add(detail);
            if (offer != null) {
                var qrRows = Desktop.Items(Desktop.Get(offer, "qr")).Select(row => Desktop.Items(row).Select(value => Convert.ToBoolean(value)).ToArray()).ToArray();
                var qr = new QrView(qrRows) { Width = 156, Height = 156 }; AutomationProperties.SetName(qr, "设备配对二维码");
                RenderOptions.SetEdgeMode(qr, EdgeMode.Aliased);
                var qrBorder = new Border { Background = Brushes.White, CornerRadius = new CornerRadius(10), Padding = new Thickness(10), Child = qr, Margin = new Thickness(0, 0, 24, 0) };
                var code = Text(Desktop.Text(offer, "code"), 30, "Primary", true); code.FontFamily = new FontFamily("Consolas"); code.Margin = new Thickness(0, 8, 0, 8);
                var countdown = Text("", 11, "Secondary"); countdowns.Add(countdown);
                var copy = Button("复制配对链接", () => Clipboard.SetText(Desktop.Text(offer, "link")), false, true); copy.HorizontalAlignment = HorizontalAlignment.Left; copy.IsEnabled = !preview;
                var info = Stack(Text(preview ? "设计预览 · 示例二维码" : "在 LinkShell 手机端扫描", 14), Text(preview ? "不可用于配对" : "也可以输入配对码", 11, "Secondary"), code, countdown, copy);
                var offerRow = new DockPanel { Margin = new Thickness(0, 20, 0, 0) }; DockPanel.SetDock(qrBorder, Dock.Left); offerRow.Children.Add(qrBorder); offerRow.Children.Add(info); panel.Children.Add(offerRow);
                if (pairExpiry <= DateTime.UtcNow) { qrBorder.Visibility = Visibility.Collapsed; code.Text = "已过期"; }
            }
            var card = Card(panel); card.Margin = new Thickness(0, 0, 0, 8); parent.Children.Add(card);
        }
        async void Pair() {
            if (preview || pairing || busy) return; pairing = true; paired = false; offer = null; notice = ""; initialDevices = new HashSet<string>(Devices.Select(d => Desktop.Text(d, "id"))); Render();
            try { offer = await Run("pair-qr"); pairExpiry = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Number(offer, "expiresAt")); }
            catch (Exception error) { notice = error.Message; }
            finally { pairing = false; Render(); }
        }
        void UpdateCountdown() {
            if (offer == null) return;
            int remaining = Math.Max(0, (int)(pairExpiry - DateTime.UtcNow).TotalSeconds);
            foreach (var label in countdowns) label.Text = remaining > 0 ? String.Format("{0:00}:{1:00} 后失效 · 请勿分享给他人", remaining / 60, remaining % 60) : "配对码已过期，请重新生成。";
            if (remaining == 0) { offer = null; notice = "配对码已过期，请重新生成。"; Render(); }
        }
        void DevicesPage() {
            PairingSection(content);
            Heading(content, "已配对设备");
            if (!Devices.Any()) Empty(content, "暂无已配对设备", "在手机中打开「电脑 → 添加电脑」，扫描上方生成的二维码。", "\uE8EA");
            foreach (var device in Devices) Row(content, Desktop.Text(device, "name"), Status(Yes(device, "online") ? "在线" : "离线", Yes(device, "online") ? "Accent" : "Secondary"));
            string url = Desktop.Text(Desktop.Get(snapshot, "gateway"), "url"); if (url.Length > 0) { var label = Text(url, 12, "Secondary"); label.Margin = new Thickness(0, 24, 0, 0); content.Children.Add(label); }
            var error = Desktop.Text(Desktop.Get(Desktop.Get(snapshot, "gateway"), "error"), "message"); if (error.Length > 0) content.Children.Add(Text(error, 12, "Warning"));
        }
        string SessionLabel(object session) {
            if (Number(session, "pendingPermissions") > 0) return "等待确认";
            string state = Desktop.Text(session, "state"); return state == "running" ? "运行中" : state == "waiting" ? "等待输入" : state == "idle" ? "空闲" : state == "error" ? "异常" : state == "offline" ? "离线" : "未知";
        }
        string SessionName(object session) { string title = Desktop.Text(session, "title"); if (title.Length > 0) return title; try { return System.IO.Path.GetFileName(Desktop.Text(session, "cwd").TrimEnd('\\', '/')); } catch { return "未命名会话"; } }
        UIElement AgentLabel(string id, string name = null, double size = 20) {
            var panel = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            var source = Asset("agent." + id + "." + (dark ? "dark" : "light") + ".png");
            if (source != null) panel.Children.Add(new Image { Source = source, Width = size, Height = size, Margin = new Thickness(0, 0, 8, 0) });
            panel.Children.Add(Text(name ?? (id == "codex" ? "Codex" : id == "claude" ? "Claude Code" : id), 12)); return panel;
        }
        void SessionTable(Panel parent, IEnumerable<object> entries) {
            var list = entries.ToArray();
            if (list.Length == 0) { Empty(parent, Healthy ? "暂无会话" : "会话不可用", Healthy ? "从手机或 Web 工作区创建会话，即可在这里查看进度。" : "连接本机服务后查看会话。", "\uE8BD"); return; }
            var header = TableRow(new UIElement[] { Text("项目", 12, "Secondary"), Text("代理", 12, "Secondary"), Text("状态", 12, "Secondary") }, new[] { 1.0, 145.0, 112.0 }); header.Margin = new Thickness(0, 0, 0, 12); parent.Children.Add(header); parent.Children.Add(Rule());
            foreach (var session in list) {
                var name = Text(SessionName(session), 13); name.TextWrapping = TextWrapping.NoWrap; name.TextTrimming = TextTrimming.CharacterEllipsis; name.ToolTip = Desktop.Text(session, "cwd");
                string status = SessionLabel(session); string tone = status == "运行中" ? "Accent" : status == "等待确认" || status == "等待输入" || status == "异常" ? "Warning" : "Secondary";
                var row = TableRow(new[] { (UIElement)name, AgentLabel(Desktop.Text(session, "agent")), Status(status, tone) }, new[] { 1.0, 145.0, 112.0 });
                var button = Button(SessionName(session), () => SessionDetail(session), false, true); button.Content = row; button.HorizontalContentAlignment = HorizontalAlignment.Stretch; button.Padding = new Thickness(0, 16, 0, 16); parent.Children.Add(button); parent.Children.Add(Rule());
            }
        }
        Grid TableRow(UIElement[] cells, double[] widths) {
            var grid = new Grid();
            for (int i = 0; i < cells.Length; i++) { grid.ColumnDefinitions.Add(new ColumnDefinition { Width = widths[i] <= 1 ? new GridLength(widths[i], GridUnitType.Star) : new GridLength(widths[i]) }); Grid.SetColumn(cells[i], i); grid.Children.Add(cells[i]); }
            return grid;
        }
        void SessionDetail(object session) {
            string status = SessionLabel(session);
            var body = Stack(Status(status, status == "运行中" ? "Accent" : status == "等待确认" || status == "等待输入" ? "Warning" : "Secondary"), Text(Desktop.Text(session, "cwd"), 12, "Secondary"), AgentLabel(Desktop.Text(session, "agent")));
            foreach (FrameworkElement child in body.Children) child.Margin = new Thickness(0, 0, 0, 16);
            if (Number(session, "pendingPermissions") > 0) body.Children.Add(Text("有 " + Number(session, "pendingPermissions") + " 个请求等待确认，请在手机或原代理终端处理。", 13, "Warning"));
            ShowDialog(SessionName(session), body, "完成", () => {}, false);
        }

        void SettingsPage() {
            Row(content, "外观", Segments(new[] { "跟随系统", "浅色", "深色" }, new[] { "system", "light", "dark" }, appearance, SaveAppearance));
            AccountSection(content);
            bool enabled; using (var run = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")) enabled = run != null && run.GetValue("LinkShell") != null;
            var startup = new CheckBox { Content = "登录 Windows 时自动启动", IsChecked = enabled, Margin = new Thickness(0, 20, 0, 10), IsEnabled = !preview };
            startup.Click += (s, e) => {
                try { using (var run = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")) { if (startup.IsChecked == true) run.SetValue("LinkShell", Desktop.Quote(Assembly.GetExecutingAssembly().Location) + " --hidden"); else run.DeleteValue("LinkShell", false); } }
                catch (Exception error) { startup.IsChecked = enabled; ShowError(error); }
            }; content.Children.Add(startup);
            content.Children.Add(Text("登录后自动打开桌面版并启动后台服务。窗口关闭后留在托盘。", 12, "Secondary")); content.Children.Add(Rule(18, 0));
            string disabled = System.IO.Path.Combine(Desktop.Home, "windows-screen-disabled");
            var sharing = new CheckBox { Content = "允许远程屏幕与控制", IsChecked = !File.Exists(disabled), Margin = new Thickness(0, 20, 0, 10), IsEnabled = !preview };
            sharing.Click += (s, e) => { try { if (sharing.IsChecked == true) File.Delete(disabled); else File.WriteAllText(disabled, "disabled\n"); } catch (Exception error) { sharing.IsChecked = !File.Exists(disabled); ShowError(error); } }; content.Children.Add(sharing);
            content.Children.Add(Text("允许已连接设备查看屏幕和控制鼠标键盘。锁屏、UAC 安全桌面和管理员窗口不可控制。关闭后会结束屏幕连接，服务与 Agent 会话继续运行。", 12, "Secondary"));
            Heading(content, "本机 Agent");
            foreach (var entry in Desktop.Items(Desktop.Get(Desktop.Get(snapshot, "machine"), "agents"))) {
                var name = Desktop.Text(entry, "label"); var id = Desktop.Text(entry, "id");
                var left = Stack(AgentLabel(id, name)); var version = Text(Desktop.Text(entry, "version") + " " + Desktop.Text(entry, "problem"), 11, "Secondary"); version.Margin = new Thickness(28, 6, 0, 0); left.Children.Add(version);
                var row = Split(left, Status(Yes(entry, "installed") ? "已安装" : "未安装", Yes(entry, "installed") ? "Accent" : "Secondary")); row.Margin = new Thickness(0, 12, 0, 12); content.Children.Add(row); content.Children.Add(Rule());
            }
            content.Children.Add(Text("Agent 需要在这台电脑上自行安装并登录。", 12, "Secondary"));
            Heading(content, "数据与命令行");
            var path = Text(Desktop.Home, 12, "Secondary"); path.FontFamily = new FontFamily("Consolas"); content.Children.Add(path);
            var actions = new WrapPanel { Margin = new Thickness(0, 14, 0, 16) }; actions.Children.Add(Button("打开数据目录", () => Open(Desktop.Home))); var copy = Button("复制 CLI 路径", () => Clipboard.SetText(System.IO.Path.Combine(Desktop.Root, "linkshell.cmd"))); copy.Margin = new Thickness(10, 0, 0, 0); actions.Children.Add(copy); content.Children.Add(actions);
            content.Children.Add(Text("内置 linkshell.cmd 与桌面版一起更新。已有 npm 安装与系统 PATH 不会被改动。", 12, "Secondary"));
            var recover = Button("重试恢复后台服务", async () => await Perform("recover-update")); recover.Margin = new Thickness(0, 18, 0, 0); recover.HorizontalAlignment = HorizontalAlignment.Left; recover.IsEnabled = !busy && !preview; content.Children.Add(recover);
            content.Children.Add(Rule(24, 18)); content.Children.Add(Text("退出界面不会停止后台服务或 Agent 任务。", 12, "Secondary")); var quit = Button("退出 LinkShell 界面", Quit, false, true); quit.HorizontalAlignment = HorizontalAlignment.Left; quit.Margin = new Thickness(0, 10, 0, 0); content.Children.Add(quit);
        }
        UIElement Segments(string[] labels, string[] values, string chosen, Action<string> select) {
            var panel = new StackPanel { Orientation = Orientation.Horizontal };
            for (int i = 0; i < labels.Length; i++) { string value = values[i]; var button = Button(labels[i], () => select(value)); button.Background = value == chosen ? Brush("Background") : Brushes.Transparent; button.BorderThickness = new Thickness(0); button.Padding = new Thickness(13, 7, 13, 7); panel.Children.Add(button); }
            var segments = Card(panel, 3); segments.HorizontalAlignment = HorizontalAlignment.Left; return segments;
        }
        void LogsPage() {
            var actions = new WrapPanel(); actions.Children.Add(Button("刷新日志", Render)); var open = Button("打开日志文件", () => Open(System.IO.Path.Combine(Desktop.Home, "host.log"))); open.Margin = new Thickness(10, 0, 0, 0); open.IsEnabled = !preview; actions.Children.Add(open); content.Children.Add(actions);
            string text = "设计预览不读取本机日志。";
            if (!preview) {
                try {
                    string path = System.IO.Path.Combine(Desktop.Home, "host.log");
                    if (!File.Exists(path)) text = "暂无日志。启动本机服务后，日志会显示在这里。";
                    else using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) { bool partial = file.Length > 65536; file.Seek(Math.Max(0, file.Length - 65536), SeekOrigin.Begin); using (var reader = new StreamReader(file, System.Text.Encoding.UTF8)) { if (partial) reader.ReadLine(); text = reader.ReadToEnd(); } }
                } catch (Exception error) { text = "无法读取日志：" + error.Message; }
            }
            var log = new TextBox { Text = text.Length > 0 ? text : "暂无日志", IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Consolas"), FontSize = 11, BorderThickness = new Thickness(0), Background = Brushes.Transparent, Margin = new Thickness(0, 18, 0, 0) }; AutomationProperties.SetName(log, "服务日志"); content.Children.Add(log);
        }
        void UpdatesPage() {
            Row(content, "安装来源", Text("独立桌面版 · 内置运行环境", 13, "Secondary"));
            Row(content, "CLI 版本", Text(Desktop.Text(snapshot, "cliVersion").Length > 0 ? Desktop.Text(snapshot, "cliVersion") : "正在读取", 13, "Secondary"));
            Row(content, "运行中的 Host", Text(Desktop.Text(Desktop.Get(snapshot, "machine"), "hostVersion").Length > 0 ? Desktop.Text(Desktop.Get(snapshot, "machine"), "hostVersion") : "未连接", 13, "Secondary"));
            Row(content, "Windows 桌面版", Text("x64 · 手动安装更新", 13, "Secondary"));
            var message = Text(updateMessage, 14); message.Margin = new Thickness(0, 26, 0, 12); content.Children.Add(message);
            content.Children.Add(Text("桌面界面、CLI、Host 与运行时作为整体更新。Windows 当前通过安装包更新；安装前请退出托盘界面，重要任务完成后再操作。", 12, "Secondary"));
            var buttons = new WrapPanel { Margin = new Thickness(0, 22, 0, 0) }; var check = Button(checking ? "正在检查…" : "检查更新", CheckUpdates); check.IsEnabled = !checking && !preview; buttons.Children.Add(check);
            var download = Button(updateUrl == null ? "查看发布记录" : "下载 Windows 安装包", () => Open(updateUrl ?? "https://github.com/LiuTianjie/LinkShell/releases"), updateUrl != null); download.Margin = new Thickness(10, 0, 0, 0); download.IsEnabled = !preview; buttons.Children.Add(download); content.Children.Add(buttons);
        }
        async void CheckUpdates() {
            if (checking || preview) return; checking = true; updateMessage = "正在查找 Windows 稳定版…"; Render();
            try {
                using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) }) {
                    http.DefaultRequestHeaders.UserAgent.ParseAdd("LinkShell-Windows");
                    var releases = Desktop.Items(Desktop.Json.DeserializeObject(await http.GetStringAsync("https://api.github.com/repos/LiuTianjie/LinkShell/releases?per_page=20")));
                    object found = null, release = null;
                    foreach (var entry in releases) {
                        if (Yes(entry, "draft") || Yes(entry, "prerelease")) continue;
                        found = Desktop.Items(Desktop.Get(entry, "assets")).FirstOrDefault(a => Desktop.Text(a, "name").StartsWith("LinkShell-Setup-", StringComparison.Ordinal) && Desktop.Text(a, "name").EndsWith("-windows-x64.exe", StringComparison.Ordinal));
                        if (found != null) { release = entry; break; }
                    }
                    updateUrl = found == null ? null : Desktop.Text(found, "browser_download_url");
                    if (updateUrl != null && !updateUrl.StartsWith("https://github.com/LiuTianjie/LinkShell/releases/download/", StringComparison.Ordinal)) throw new InvalidOperationException("发布下载地址无效");
                    updateMessage = found == null ? "尚无已发布的 Windows 安装包" : "可下载版本：" + Desktop.Text(release, "tag_name");
                }
            } catch (Exception error) { updateUrl = null; updateMessage = "检查失败：" + error.Message; }
            finally { checking = false; Render(); }
        }

        void UsagePage() {
            var filters = new WrapPanel();
            var agentEntries = usageAgents;
            var all = Button("全部", () => SelectAgent("all")); all.Background = agent == "all" ? Brush("Selection") : Brushes.Transparent; filters.Children.Add(all);
            foreach (var entry in agentEntries) { string id = Desktop.Text(entry, "id"); var button = Button(Desktop.Text(entry, "label"), () => SelectAgent(id)); button.Content = AgentLabel(id, "", 22); button.Padding = new Thickness(8, 5, 0, 5); button.ToolTip = Desktop.Text(entry, "label"); button.Background = agent == id ? Brush("Selection") : Brushes.Transparent; button.BorderThickness = new Thickness(0); filters.Children.Add(button); }
            content.Children.Add(filters);
            var period = Segments(new[] { "今天", "近 7 天", "近 30 天" }, new[] { "1", "7", "30" }, days.ToString(), value => { days = Int32.Parse(value); LoadUsage(); });
            var sync = Button(usageLoading ? "同步中…" : "立即同步", LoadUsage); sync.IsEnabled = !usageLoading && !preview;
            var tools = Split(period, sync); tools.Margin = new Thickness(0, 14, 0, 22); content.Children.Add(tools);
            if (usageError.Length > 0) content.Children.Add(Text(usageError, 12, "Warning"));
            if (report == null) { Empty(content, usageLoading ? "正在读取本机用量…" : "暂无用量统计", "统计来自 Agent 本地日志，不代表账单或订阅剩余额度。", "\uE9D2"); return; }
            var totals = Desktop.Get(report, "totals"); bool noData = Number(totals, "records") == 0;
            var metrics = new UniformGrid { Columns = 4, Margin = new Thickness(0, 0, -10, 0) };
            string[] labels = { "总用量", "用量记录", "会话", "缓存读取占比" };
            string[] values = { Compact(Number(totals, "totalTokens")), Number(totals, "records").ToString("N0"), Number(totals, "sessions").ToString("N0"), (100 * Number(totals, "cacheReadTokens") / Math.Max(1, Number(totals, "totalTokens"))).ToString("0.0") + "%" };
            for (int i = 0; i < labels.Length; i++) { var value = Text(noData ? "—" : values[i], 27, "Primary", true); value.Margin = new Thickness(0, 10, 0, 0); var metric = Card(Stack(Text(labels[i], 12, "Secondary"), value), 14); metric.Background = Brushes.Transparent; metric.BorderBrush = Brush("Line"); metric.BorderThickness = new Thickness(1); metric.Margin = new Thickness(0, 0, 10, 0); metrics.Children.Add(metric); } content.Children.Add(metrics);
            if (noData) { var empty = Text("所选范围暂无可用数据；未上报用量不等于零消耗。", 12, "Secondary"); empty.Margin = new Thickness(0, 14, 0, 0); content.Children.Add(empty); }
            Heading(content, "使用趋势");
            var daily = Desktop.Items(Desktop.Get(report, "daily")).ToArray(); double max = Math.Max(1, daily.Select(d => Number(d, "totalTokens")).DefaultIfEmpty(0).Max());
            var chart = new UniformGrid { Columns = Math.Max(1, daily.Length), Height = 156 };
            for (int i = 0; i < daily.Length; i++) {
                var day = daily[i]; string date = Desktop.Text(day, "date"); double tokens = Number(day, "totalTokens");
                var bar = new Border { Background = Brush("Accent"), Height = tokens == 0 ? 1 : Math.Max(3, tokens / max * 120), Width = Math.Max(4, Math.Min(32, 340.0 / Math.Max(1, daily.Length))), VerticalAlignment = VerticalAlignment.Bottom, CornerRadius = new CornerRadius(3, 3, 0, 0), Opacity = 0.85, ToolTip = date + " · " + tokens.ToString("N0") + " Token" }; AutomationProperties.SetName(bar, date + " " + tokens.ToString("N0") + " Token");
                var column = new Grid(); column.RowDefinitions.Add(new RowDefinition()); column.RowDefinitions.Add(new RowDefinition { Height = new GridLength(26) }); column.Children.Add(bar);
                var label = Text(i % Math.Max(1, daily.Length / 7) == 0 ? date.Substring(Math.Max(0, date.Length - 5)) : "", 10, "Secondary"); label.HorizontalAlignment = HorizontalAlignment.Center; Grid.SetRow(label, 1); column.Children.Add(label); chart.Children.Add(column);
            }
            content.Children.Add(chart); content.Children.Add(Rule());
            Heading(content, "模型明细");
            var models = Desktop.Items(Desktop.Get(report, "models")).ToArray();
            if (models.Length == 0) Empty(content, "所选范围暂无模型用量", "连接服务后，支持的 Agent 用量会汇总到这里。", "\uE9D2");
            foreach (var model in models) {
                var left = Stack(AgentLabel(Desktop.Text(model, "agent")), Text(Desktop.Text(model, "model"), 12, "Secondary"));
                var right = Stack(Text(Compact(Number(model, "totalTokens")) + " Token", 15, "Primary", true), Text("输入 " + Compact(Number(model, "inputTokens")) + " · 输出 " + Compact(Number(model, "outputTokens")) + " · 缓存 " + Compact(Number(model, "cacheReadTokens")), 10, "Secondary"));
                var row = Split(left, right); row.Margin = new Thickness(0, 12, 0, 12); content.Children.Add(row); content.Children.Add(Rule());
            }
            foreach (var warning in Desktop.Items(Desktop.Get(report, "warnings"))) content.Children.Add(Text(Convert.ToString(warning), 11, "Warning"));
            var agentInfo = usageAgents.FirstOrDefault(entry => Desktop.Text(entry, "id") == agent);
            if (agentInfo != null) content.Children.Add(Text(Desktop.Text(agentInfo, "note"), 11, "Secondary"));
            var note = Text(Desktop.Text(report, "timezone") + " · 输入不含缓存 · 本地日志统计，不代表账单或剩余额度", 10, "Secondary"); note.Margin = new Thickness(0, 20, 0, 0); content.Children.Add(note);
        }
        void SelectAgent(string value) { agent = value; LoadUsage(); }
        async void LoadUsage() {
            if (preview) { Render(); return; }
            int generation = ++usageGeneration; string query = "usage-" + days + "-" + agent;
            usageLoading = true; usageError = ""; report = null; Render();
            try { var data = await Run(query); if (generation == usageGeneration) { report = data; usageAgents = Desktop.Items(Desktop.Get(data, "agents")).ToArray(); } }
            catch (Exception error) { if (generation == usageGeneration) { report = null; usageError = "无法读取用量：" + error.Message; } }
            finally { if (generation == usageGeneration) { usageLoading = false; Render(); } }
        }

        async Task<Dictionary<string, object>> Run(string action, bool loggingIn = false, string input = null) {
            using (var child = Desktop.Cli(action)) {
                if (loggingIn) login = child;
                if (action == "account-refresh" || action == "redeem-pro") accountAction = child;
                try {
                    var output = child.StandardOutput.ReadToEndAsync(); var errors = child.StandardError.ReadToEndAsync();
                    if (input != null) await child.StandardInput.WriteAsync(input);
                    child.StandardInput.Close();
                    bool exited = await Task.Run(() => child.WaitForExit(loggingIn ? 330000 : action.StartsWith("usage-", StringComparison.Ordinal) ? 150000 : action == "redeem-pro" ? 90000 : 60000));
                    if (!exited) { child.Kill(); throw new TimeoutException("操作超时，请查看服务日志后重试。"); }
                    var text = await output; var stderr = await errors;
                    var last = text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
                    var result = last == null ? null : Desktop.Json.Deserialize<Dictionary<string, object>>(last);
                    if (child.ExitCode != 0 || result == null || Desktop.Get(result, "error") != null) throw new InvalidOperationException(result != null ? Desktop.Text(result, "error") : stderr.Length > 0 ? stderr : "操作已取消");
                    return result;
                } finally { if (loggingIn) login = null; if (accountAction == child) accountAction = null; }
            }
        }
        async Task RefreshStatus() {
            if (polling || quitting || preview) return; polling = true;
            try {
                var next = await Run("snapshot"); string json = Desktop.Json.Serialize(next); bool recovered = statusError.Length > 0; statusError = "";
                if (Desktop.Text(next, "status") != Desktop.Text(snapshot, "status")) AddActivity(Desktop.Text(next, "status") == "running" ? "本机服务已连接" : "本机服务状态已变化");
                if (snapshot != null && Desktop.Text(Desktop.Get(next, "gateway"), "status") != Desktop.Text(Desktop.Get(snapshot, "gateway"), "status")) AddActivity("网关连接状态已变化");
                snapshot = next;
                if (offer != null && Devices.Any(d => !initialDevices.Contains(Desktop.Text(d, "id")))) { offer = null; paired = true; AddActivity("新设备已配对"); }
                // Leave the log selection intact while the user reads or copies it.
                if ((json != snapshotJson || recovered || selected == "日志") && !(selected == "日志" && content.IsKeyboardFocusWithin)) { snapshotJson = json; Render(); }
            } catch (Exception error) { snapshot = null; snapshotJson = ""; statusError = "无法读取本机状态：" + error.Message; Render(); }
            finally { polling = false; }
            if (SignedIn && !busy && DateTime.UtcNow - lastAccountRefresh > TimeSpan.FromMinutes(5)) RefreshAccount();
        }
        async void RefreshAccount() {
            if (busy || preview || !SignedIn) return;
            busy = true; lastAccountRefresh = DateTime.UtcNow; Render();
            try { snapshot = await Run("account-refresh"); loginMessage = Desktop.Text(snapshot, "accountWarning"); }
            catch (Exception error) { loginMessage = error.Message; }
            finally { busy = false; Render(); }
        }
        void Redeem() {
            if (busy || preview || !SignedIn) return;
            string userId = Desktop.Text(Desktop.Get(snapshot, "account"), "userId");
            var code = new PasswordBox { MaxLength = 512, Padding = new Thickness(10), Margin = new Thickness(0, 12, 0, 0) };
            ShowDialog("兑换 Pro 激活码", Stack(Text("激活码将兑换到当前账号。", 13, "Secondary"), code), "兑换", async () => {
                string value = code.Password.Trim(); code.Clear();
                if (value.Length == 0) { notice = "请输入激活码"; Render(); return; }
                busy = true; Render();
                try {
                    var next = await Run("redeem-pro", false, Desktop.Json.Serialize(new { code = value, userId = userId })); value = null;
                    snapshot = next;
                    if (Desktop.Text(Desktop.Get(next, "redemption"), "userId") != userId) throw new InvalidOperationException("尚未确认兑换结果，请刷新会员状态。");
                    loginMessage = "兑换成功，Pro 会员状态已更新。" + Desktop.Text(next, "accountWarning");
                    lastAccountRefresh = DateTime.UtcNow;
                } catch (Exception error) { loginMessage = error.Message; }
                finally { busy = false; Render(); }
            });
            code.Focus();
        }
        void AddActivity(string message) { activity.Insert(0, Tuple.Create(DateTime.Now, message)); if (activity.Count > 20) activity.RemoveAt(activity.Count - 1); }
        async Task Perform(string action) {
            if (busy || preview) return; busy = true; notice = ""; Render();
            try { await Run(action); AddActivity(action == "start" ? "已启动后台服务" : action == "stop" ? "已停止后台服务" : action == "restart" ? "已重启后台服务" : "设置已更新"); await RefreshStatus(); }
            catch (Exception error) { notice = error.Message; }
            finally { busy = false; Render(); }
        }
        async void Login() {
            if (signingIn || preview) return; signingIn = true; loginMessage = "请在系统浏览器完成登录…"; Render();
            try { await Run("login", true); loginMessage = ""; await RefreshStatus(); }
            catch (Exception error) { loginMessage = "登录未完成：" + error.Message; }
            finally { signingIn = false; Render(); }
        }
        void CancelLogin() { if (login != null) { try { if (!login.HasExited) login.Kill(); } catch (InvalidOperationException) {} } }
        void ConfirmAction(string action) {
            string heading = action == "logout" ? "退出当前账号？" : action == "connect-gateway" ? "连接官方网关？" : action == "stop" ? "停止本机服务？" : "重启本机服务？";
            string message = action == "logout" ? "当前电脑将退出账号，账号关联的远程连接可能断开。本机会话和配对记录会保留。" : action == "connect-gateway" ? "将切换到官方网关，手机登录同一账号即可发现这台电脑。官方网关需要 Pro，现有远程连接可能断开。" : "正在执行的 Agent 任务、终端与远程连接可能中断。会话记录和配对信息会保留。";
            ShowDialog(heading, Text(message, 13, "Secondary"), "继续", async () => { if (action == "logout") CancelLogin(); await Perform(action); });
        }
        void ShowDialog(string heading, UIElement body, string confirm, Action action, bool cancel = true) {
            var headingLabel = Text(heading, 21, "Primary", true); headingLabel.Margin = new Thickness(0, 0, 0, 20);
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 26, 0, 0) };
            if (cancel) { var dismiss = Button("取消", () => CloseDialog()); dismiss.Margin = new Thickness(0, 0, 10, 0); buttons.Children.Add(dismiss); }
            var accept = Button(confirm, () => { CloseDialog(); action(); }, true); buttons.Children.Add(accept);
            var card = Card(Stack(headingLabel, body, buttons), 28); card.Width = 480; card.MaxWidth = Math.Max(360, ActualWidth - 80); card.HorizontalAlignment = HorizontalAlignment.Center; card.VerticalAlignment = VerticalAlignment.Center; card.Background = Brush("Sidebar"); card.BorderBrush = Brush("Line"); card.BorderThickness = new Thickness(1);
            KeyboardNavigation.SetTabNavigation(card, KeyboardNavigationMode.Cycle);
            root.Children[0].IsEnabled = false; root.Children[1].IsEnabled = false;
            overlay.Child = card; overlay.Visibility = Visibility.Visible; if (cancel) ((Button)buttons.Children[0]).Focus(); else accept.Focus();
        }
        void CloseDialog() { overlay.Visibility = Visibility.Collapsed; root.Children[0].IsEnabled = true; root.Children[1].IsEnabled = true; navButtons[selected].Focus(); }
        void ShowError(Exception error) { notice = error.Message; Render(); }
        void ShowServiceMenu() {
            if (servicePopup != null && servicePopup.IsOpen) { servicePopup.IsOpen = false; return; }
            var actions = new StackPanel();
            var popup = new Popup { PlacementTarget = serviceMenuButton, Placement = PlacementMode.Bottom, HorizontalOffset = -150, VerticalOffset = 6, StaysOpen = false, AllowsTransparency = true };
            popup.Resources = Resources;
            var refresh = Button("刷新状态", async () => { popup.IsOpen = false; await RefreshStatus(); }, false, true); actions.Children.Add(refresh); actions.Children.Add(Rule(4, 4));
            foreach (string action in new[] { "start", "restart", "stop" }) {
                string value = action; var button = Button(action == "start" ? "启动服务" : action == "restart" ? "重启服务…" : "停止服务…", async () => { popup.IsOpen = false; if (value == "start") await Perform(value); else ConfirmAction(value); }, false, true);
                button.IsEnabled = !preview && !busy && (action == "start" ? !Healthy : Healthy); actions.Children.Add(button);
            }
            foreach (var button in actions.Children.OfType<Button>()) { button.HorizontalContentAlignment = HorizontalAlignment.Left; button.Padding = new Thickness(12, 9, 12, 9); }
            var card = Card(actions, 6); card.Width = 186; card.Background = Brush("Sidebar"); card.BorderBrush = Brush("Line"); card.BorderThickness = new Thickness(1);
            KeyboardNavigation.SetTabNavigation(card, KeyboardNavigationMode.Cycle);
            card.PreviewKeyDown += (s, e) => { if (e.Key == Key.Escape) { popup.IsOpen = false; serviceMenuButton.Focus(); e.Handled = true; } };
            popup.Child = card; servicePopup = popup; popup.IsOpen = true; refresh.Focus();
        }
        void ToggleTray() {
            if (trayPanel != null) { trayPanel.Close(); return; }
            trayPanel = new Window { Title = "LinkShell · 快捷面板", Width = 320, SizeToContent = SizeToContent.Height, WindowStyle = WindowStyle.None, ResizeMode = ResizeMode.NoResize, ShowInTaskbar = false, Topmost = true, Background = Brush("Sidebar"), Foreground = Brush("Primary"), FontFamily = FontFamily, FontSize = 13, UseLayoutRounding = true };
            trayPanel.Resources = Resources;
            var logo = new StackPanel { Orientation = Orientation.Horizontal }; logo.Children.Add(new Image { Source = Asset("brand.png"), Width = 36, Height = 36, Margin = new Thickness(0, 0, 12, 0) }); logo.Children.Add(Text("LinkShell", 20, "Primary", true));
            var panel = Stack(logo); var status = (FrameworkElement)Status("服务" + ServiceLabel, Healthy ? "Accent" : "Secondary"); status.Margin = new Thickness(48, 10, 0, 20); panel.Children.Add(status); panel.Children.Add(Rule());
            Row(panel, "网关", Text(GatewayLabel, 13, "Secondary")); Row(panel, "设备", Text(Healthy ? Devices.Count(d => Yes(d, "online")) + " 台在线" : "未知", 13, "Secondary")); Row(panel, "会话", Text(Healthy ? Sessions.Count(s => Desktop.Text(s, "state") == "running") + " 个运行中" : "未知", 13, "Secondary"));
            int pending = (int)Sessions.Sum(s => Number(s, "pendingPermissions")); if (pending > 0) panel.Children.Add(Button(pending + " 个请求等待确认", () => ShowPage("会话"), false, true));
            foreach (var page in new[] { "工作台", "总览", "用量统计", "更新", "设置" }) { string target = page; var link = Button(page == "工作台" ? "打开 LinkShell" : page, () => ShowPage(target), false, true); link.HorizontalContentAlignment = HorizontalAlignment.Left; link.Margin = new Thickness(0, 4, 0, 0); panel.Children.Add(link); }
            panel.Children.Add(Rule(10, 8)); var exit = Button("退出界面", Quit, false, true); exit.HorizontalContentAlignment = HorizontalAlignment.Left; panel.Children.Add(exit);
            var border = Card(panel, 22); border.Background = Brush("Sidebar"); border.BorderBrush = Brush("Line"); border.BorderThickness = new Thickness(1); trayPanel.Content = border;
            trayPanel.Loaded += (s, e) => { if (trayPanel != null) { var area = SystemParameters.WorkArea; trayPanel.Left = area.Right - trayPanel.ActualWidth - 12; trayPanel.Top = area.Bottom - trayPanel.ActualHeight - 12; } };
            trayPanel.PreviewKeyDown += (s, e) => { if (e.Key == Key.Escape && trayPanel != null) { trayPanel.Close(); e.Handled = true; } };
            trayPanel.Deactivated += (s, e) => { if (trayPanel != null) trayPanel.Close(); }; trayPanel.Closed += (s, e) => trayPanel = null; trayPanel.Show(); trayPanel.Activate();
        }
        void ShowPage(string page) { if (trayPanel != null) trayPanel.Close(); Show(); if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal; Activate(); Navigate(page); }
        public void Restore() { ShowPage(management ? selected : "工作台"); }
        async void Quit() {
            if (exiting) return; exiting = true;
            try {
                if (!await workspace.CanDiscard("退出")) return;
                quitting = true; CancelLogin(); if (trayPanel != null) trayPanel.Close();
                if (accountAction != null) { try { if (!accountAction.HasExited) accountAction.Kill(); } catch (InvalidOperationException) {} }
                await workspace.SetState(false, appearance); await workspace.Stop(); Close(); Application.Current.Shutdown();
            } finally { exiting = false; }
        }
        static void Open(string value) { Process.Start(new ProcessStartInfo(value) { UseShellExecute = true }); }
        void LoadPreview() {
            using (var stream = Resource("PreviewSnapshot.json")) using (var reader = new StreamReader(stream)) snapshot = Desktop.Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            using (var stream = Resource("PreviewUsage.json")) using (var reader = new StreamReader(stream)) report = Desktop.Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            using (var stream = Resource("PreviewPair.json")) using (var reader = new StreamReader(stream)) offer = Desktop.Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            pairExpiry = DateTime.UtcNow.AddMinutes(10);
            usageAgents = Desktop.Items(Desktop.Get(report, "agents")).ToArray();
            AddActivity("手机已连接"); AddActivity("本机服务已连接");
        }
    }
    internal sealed class QrView : FrameworkElement {
        readonly bool[][] modules;
        public QrView(bool[][] value) { modules = value; }
        protected override void OnRender(DrawingContext drawing) {
            drawing.DrawRectangle(Brushes.White, null, new Rect(RenderSize));
            if (modules.Length == 0) return;
            // Four quiet modules on each edge are required by phone scanners.
            double cell = Math.Min(ActualWidth, ActualHeight) / (modules.Length + 8);
            for (int y = 0; y < modules.Length; y++) for (int x = 0; x < modules[y].Length; x++) if (modules[y][x]) drawing.DrawRectangle(Brushes.Black, null, new Rect((x + 4) * cell, (y + 4) * cell, cell + 0.02, cell + 0.02));
        }
    }
}
