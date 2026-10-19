using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace LinkShell.Windows {
    internal static class Installer {
        [STAThread] static int Main() {
            bool created;
            using (var single = new Mutex(true, "Local\\LinkShell-Installer", out created)) {
                if (!created) { MessageBox.Show("另一个 LinkShell 安装程序正在运行，请回到该窗口继续。", "LinkShell 安装"); return 1; }
                var destination = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "LinkShell");
                var engine = new InstallerEngine(destination, () => Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"));
                try {
                    var window = new InstallerWindow(engine);
                    new Application().Run(window);
                    return window.ExitCode;
                } catch (Exception error) { MessageBox.Show("无法打开安装程序：" + error.Message, "LinkShell 安装", MessageBoxButton.OK, MessageBoxImage.Error); return 1; }
            }
        }
    }

    internal sealed class InstallerWindow : Window {
        readonly InstallerEngine engine;
        readonly TextBlock heading, description, stage, percent, detail, result;
        readonly ProgressBar progress;
        readonly Button primary, secondary;
        readonly Border progressCard;
        readonly CheckBox launch;
        readonly string version;
        CancellationTokenSource cancellation;
        bool working, committing, installed;
        public int ExitCode { get; private set; }
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr handle, int attribute, ref int value, int size);

        public InstallerWindow(InstallerEngine installEngine) {
            engine = installEngine;
            Title = "LinkShell 安装";
            Width = 660; Height = 590; ResizeMode = ResizeMode.NoResize;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            FontFamily = new FontFamily("Segoe UI, Microsoft YaHei UI"); FontSize = 13;
            UseLayoutRounding = true; SnapsToDevicePixels = true;
            using (var stream = Resource("DesktopTheme.xaml")) Resources.MergedDictionaries.Add((ResourceDictionary)XamlReader.Load(stream));
            Background = Brush("Background"); Foreground = Brush("Primary");
            using (var stream = Resource("installer-version.txt")) using (var reader = new StreamReader(stream)) version = reader.ReadToEnd().Trim();
            using (var stream = Resource("brand.png")) {
                var image = new BitmapImage(); image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad; image.StreamSource = stream; image.EndInit(); image.Freeze(); Icon = image;
            }
            var root = new Grid { Margin = new Thickness(36, 30, 36, 26) };
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition());
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var brand = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 28) };
            brand.Children.Add(new Image { Source = Icon, Width = 42, Height = 42, Margin = new Thickness(0, 0, 14, 0) });
            var name = new StackPanel(); name.Children.Add(Label("LinkShell", 20, true)); name.Children.Add(Label("Windows 桌面版  ·  " + version, 12, false, "Secondary")); brand.Children.Add(name); root.Children.Add(brand);
            var body = new StackPanel(); var bodyScroll = new ScrollViewer { Content = body, Padding = new Thickness(0, 0, 6, 0) }; Grid.SetRow(bodyScroll, 1); root.Children.Add(bodyScroll);
            heading = Label("准备安装 LinkShell", 27, true); body.Children.Add(heading);
            description = Label("从手机连接这台电脑，跟进 Agent 任务、终端和远程屏幕。", 13, false, "Secondary"); description.Margin = new Thickness(0, 10, 0, 22); body.Children.Add(description);
            var path = new StackPanel(); path.Children.Add(Label("安装位置", 12, false, "Secondary"));
            var location = new TextBox { Text = engine.Destination, IsReadOnly = true, BorderThickness = new Thickness(0), Background = Brushes.Transparent, Padding = new Thickness(0), Margin = new Thickness(0, 8, 0, 0), TextWrapping = TextWrapping.Wrap }; AutomationProperties.SetName(location, "安装位置"); path.Children.Add(location);
            body.Children.Add(new Border { Child = path, Background = Brush("Sidebar"), BorderBrush = Brush("Line"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(18), Margin = new Thickness(0, 0, 0, 18) });
            var status = new StackPanel(); var row = new DockPanel();
            percent = Label("0%", 13, true, "Accent"); DockPanel.SetDock(percent, Dock.Right); row.Children.Add(percent);
            stage = Label("准备安装", 13); row.Children.Add(stage); status.Children.Add(row);
            progress = new ProgressBar { Minimum = 0, Maximum = 100, Height = 7, Margin = new Thickness(0, 14, 0, 12), Foreground = Brush("Accent"), Background = Brush("Line"), BorderThickness = new Thickness(0) };
            progress.Template = (ControlTemplate)XamlReader.Parse("<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='ProgressBar'><Grid><Border x:Name='PART_Track' CornerRadius='3' Background='{TemplateBinding Background}'/><Border x:Name='PART_Indicator' HorizontalAlignment='Left' CornerRadius='3' Background='{TemplateBinding Foreground}'/></Grid></ControlTemplate>");
            AutomationProperties.SetName(progress, "安装进度"); status.Children.Add(progress);
            detail = Label("", 11, false, "Secondary"); detail.TextWrapping = TextWrapping.NoWrap; detail.TextTrimming = TextTrimming.CharacterEllipsis; status.Children.Add(detail);
            progressCard = new Border { Child = status, Visibility = Visibility.Collapsed, Margin = new Thickness(0, 0, 0, 16) }; body.Children.Add(progressCard);
            result = Label("仅为当前用户安装，无需管理员权限。\n更新前请从托盘退出 LinkShell；更新会暂时停止其托管的服务，可能中断任务。账号、配对和会话历史会保留。", 12, false, "Secondary"); result.LineHeight = 21; body.Children.Add(result);
            launch = new CheckBox { Content = "安装完成后启动 LinkShell", IsChecked = true, Margin = new Thickness(0, 20, 0, 0), Visibility = Visibility.Collapsed }; body.Children.Add(launch);
            var footer = new StackPanel(); Grid.SetRow(footer, 2); root.Children.Add(footer);
            footer.Children.Add(new Border { Height = 1, Background = Brush("Line"), Margin = new Thickness(0, 18, 0, 18) });
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            secondary = new Button { Content = "取消", MinWidth = 90, Margin = new Thickness(0, 0, 12, 0) }; secondary.Click += (s, e) => CancelOrClose(); buttons.Children.Add(secondary);
            primary = new Button { Content = "安装", MinWidth = 124, Background = Brush("Accent"), Foreground = Brush("OnAccent"), FontWeight = FontWeights.SemiBold, BorderThickness = new Thickness(0), IsDefault = true }; primary.Click += async (s, e) => { if (installed) Finish(); else await BeginInstall(); }; buttons.Children.Add(primary); footer.Children.Add(buttons);
            Content = root;
            SourceInitialized += (s, e) => { int value = 1; try { DwmSetWindowAttribute(new WindowInteropHelper(this).Handle, 20, ref value, 4); } catch (DllNotFoundException) {} };
            Closing += (s, e) => { if (working) { e.Cancel = true; CancelOrClose(); } };
        }

        static Stream Resource(string name) { return Assembly.GetExecutingAssembly().GetManifestResourceStream(name); }
        Brush Brush(string key) { return (Brush)FindResource(key); }
        TextBlock Label(string value, double size, bool bold = false, string tone = "Primary") { return new TextBlock { Text = value, FontSize = size, FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal, Foreground = Brush(tone), VerticalAlignment = VerticalAlignment.Center }; }

        internal async Task BeginInstall() {
            if (working) return;
            working = true; committing = false; ExitCode = 0;
            cancellation = new CancellationTokenSource();
            heading.Text = "正在安装 LinkShell"; description.Text = "安装完成后，即可从开始菜单打开。";
            progressCard.Visibility = Visibility.Visible; progress.Value = 0; percent.Text = "0%";
            stage.Text = "检查安装环境"; detail.Text = "正在准备安装文件…";
            result.Text = "正在解压文件，此阶段可以安全取消。"; result.Foreground = Brush("Secondary");
            primary.Content = "正在安装…"; primary.IsEnabled = false; secondary.Content = "取消安装"; secondary.IsEnabled = true;
            try {
                var updates = new Progress<InstallProgress>(value => {
                    progress.Value = value.Percent; percent.Text = value.Percent + "%"; stage.Text = value.Stage; detail.Text = value.Detail;
                });
                await Task.Run(() => engine.Install(updates, cancellation.Token, () => Dispatcher.Invoke(new Action(() => {
                    cancellation.Token.ThrowIfCancellationRequested();
                    committing = true; secondary.IsEnabled = false;
                    result.Text = "正在应用安装并处理后台服务，请保持窗口打开。";
                }))));
                installed = true; progress.Value = 100; percent.Text = "100%"; stage.Text = "安装完成"; detail.Text = "已创建开始菜单快捷方式";
                heading.Text = "LinkShell 已准备就绪"; description.Text = "安装成功。开始连接你的手机。";
                result.Text = "账号、配对和会话历史已保留。";
                primary.Content = "完成"; secondary.Content = "打开安装目录"; secondary.IsEnabled = true; launch.Visibility = Visibility.Visible;
            } catch (OperationCanceledException) {
                ExitCode = 0; heading.Text = "安装已取消"; description.Text = "临时文件已清理，现有安装保持不变。";
                stage.Text = "已取消"; detail.Text = ""; result.Text = "可以随时重新开始安装。";
                primary.Content = "重新安装"; secondary.Content = "关闭"; secondary.IsEnabled = true;
            } catch (Exception error) {
                ExitCode = 1; heading.Text = "安装未完成"; description.Text = "解决下方问题后，可以重新尝试。";
                stage.Text = "安装失败"; detail.Text = ""; result.Text = error.Message; result.Foreground = Brush("Warning");
                primary.Content = "重试安装"; secondary.Content = "关闭"; secondary.IsEnabled = true;
            } finally { working = false; committing = false; primary.IsEnabled = true; cancellation.Dispose(); cancellation = null; }
        }
        void CancelOrClose() {
            if (working) { if (!committing) { cancellation.Cancel(); secondary.IsEnabled = false; result.Text = "正在取消并清理临时文件…"; } return; }
            if (installed) { Open(engine.Destination); return; }
            Close();
        }
        void Finish() { if (launch.IsChecked == true && !Open(Path.Combine(engine.Destination, "LinkShell.exe"))) return; Close(); }
        bool Open(string path) {
            try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); return true; }
            catch (Exception error) { result.Text = "安装已完成，但无法打开：" + error.Message; result.Foreground = Brush("Warning"); return false; }
        }
    }
}
