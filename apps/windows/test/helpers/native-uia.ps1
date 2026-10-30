[CmdletBinding(DefaultParameterSetName = 'Invoke')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$AppProcessId,

    [Parameter(Mandatory = $true, ParameterSetName = 'Invoke')]
    [Parameter(ParameterSetName = 'Inspect')]
    [ValidateNotNullOrEmpty()]
    [string]$ButtonName,

    [Parameter(Mandatory = $true, ParameterSetName = 'Inspect')]
    [switch]$InspectOnly,

    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 60,

    [string]$DumpPath,
    [string]$ScreenshotPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-Result {
    param([object]$Value, [int]$ExitCode)
    $json = $Value | ConvertTo-Json -Depth 8 -Compress
    if ($DumpPath) {
        $fullPath = [System.IO.Path]::GetFullPath($DumpPath)
        $directory = [System.IO.Path]::GetDirectoryName($fullPath)
        if ($directory) { [System.IO.Directory]::CreateDirectory($directory) | Out-Null }
        [System.IO.File]::WriteAllText($fullPath, $json, [System.Text.UTF8Encoding]::new($false))
    }
    [Console]::Out.WriteLine($json)
    exit $ExitCode
}

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    Write-Result @{ clicked = $false; pid = $AppProcessId; name = $ButtonName; error = 'This helper runs only on a Windows GitHub Actions runner.' } 4
}

function Test-TargetProcess {
    $live = Get-Process -Id $AppProcessId -ErrorAction SilentlyContinue
    if (-not $live) { return $false }
    try { return $live.StartTime.ToUniversalTime().Ticks -eq $processStart }
    catch { return $false }
    finally { $live.Dispose() }
}

function Get-WindowDiagnostic {
    param([object]$Window)
    if ($Window.Current.ProcessId -ne $AppProcessId) { return $null }
    $elements = $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $items = @()
    for ($index = 0; $index -lt [Math]::Min($elements.Count, 120); $index++) {
        try {
            $element = $elements.Item($index)
            if ($element.Current.ProcessId -ne $AppProcessId) { continue }
            $items += @{
                name = $element.Current.Name
                controlType = $element.Current.ControlType.ProgrammaticName
                enabled = $element.Current.IsEnabled
                offscreen = $element.Current.IsOffscreen
            }
        } catch [System.Windows.Automation.ElementNotAvailableException] { }
    }
    return @{
        pid = $AppProcessId
        title = $Window.Current.Name
        nativeHandle = $Window.Current.NativeWindowHandle
        offscreen = $Window.Current.IsOffscreen
        elements = $items
    }
}

function Save-WindowScreenshot {
    param([object]$Window)
    if (-not $ScreenshotPath) { return $null }
    try {
        if (-not (Test-TargetProcess) -or $Window.Current.ProcessId -ne $AppProcessId) {
            throw 'The requested process or window changed before capture.'
        }
        $handle = [IntPtr]::new($Window.Current.NativeWindowHandle)
        $fullPath = [System.IO.Path]::GetFullPath($ScreenshotPath)
        $size = [LinkShellCiWindowCapture]::Save($handle, $AppProcessId, $fullPath)
        return @{ captured = $true; path = $fullPath; method = 'PrintWindow'; width = $size[0]; height = $size[1]; windowTitle = $Window.Current.Name }
    } catch {
        return @{ captured = $false; path = $ScreenshotPath; method = 'PrintWindow'; error = $_.Exception.Message }
    }
}

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName WindowsBase
    if ($ScreenshotPath) {
        Add-Type -AssemblyName System.Drawing
        Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class LinkShellCiWindowCapture
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);

    private static void CheckOwner(IntPtr window, int expectedProcessId)
    {
        uint owner;
        if (window == IntPtr.Zero || !IsWindow(window) || GetWindowThreadProcessId(window, out owner) == 0 || owner != (uint)expectedProcessId)
            throw new InvalidOperationException("The native window is not owned by the requested process.");
    }

    public static int[] Save(IntPtr window, int expectedProcessId, string path)
    {
        CheckOwner(window, expectedProcessId);
        Rect bounds;
        if (!GetWindowRect(window, out bounds)) throw new Win32Exception(Marshal.GetLastWin32Error());
        long width = (long)bounds.Right - bounds.Left;
        long height = (long)bounds.Bottom - bounds.Top;
        if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 64000000)
            throw new InvalidOperationException("The target window has an invalid or excessive capture size.");

        using (Bitmap bitmap = new Bitmap((int)width, (int)height, PixelFormat.Format24bppRgb))
        {
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                IntPtr dc = graphics.GetHdc();
                try
                {
                    // PW_RENDERFULLCONTENT captures this HWND only. Never fall back to screen capture.
                    CheckOwner(window, expectedProcessId);
                    if (!PrintWindow(window, dc, 2)) throw new Win32Exception(Marshal.GetLastWin32Error(), "PrintWindow failed for the target window.");
                }
                finally { graphics.ReleaseHdc(dc); }
            }
            CheckOwner(window, expectedProcessId);
            string directory = Path.GetDirectoryName(path);
            if (!String.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            bitmap.Save(path, ImageFormat.Png);
        }
        return new int[] { (int)width, (int)height };
    }
}
'@
    }

    $process = Get-Process -Id $AppProcessId -ErrorAction Stop
    $processStart = $process.StartTime.ToUniversalTime().Ticks
    $process.Dispose()
    $processCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $AppProcessId
    )
    $buttonCondition = $null
    if ($ButtonName) {
        $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            $ButtonName
        )
        $typeCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button
        )
        $buttonCondition = [System.Windows.Automation.AndCondition]::new($nameCondition, $typeCondition)
    }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $lastWindows = @()
    $lastFailure = $null
    $screenshotWindow = $null

    while ($clock.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if (-not (Test-TargetProcess)) {
            Write-Result @{ clicked = $false; inspected = $false; pid = $AppProcessId; name = $ButtonName; error = 'The requested process exited or its PID was reused.'; windows = $lastWindows } 3
        }
        $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            $processCondition
        )
        $lastWindows = @()
        $screenshotWindow = $null
        $screenshotMatchesButton = $false
        foreach ($window in $windows) {
            try {
                # Every lookup remains inside a top-level window owned by the requested process.
                if ($window.Current.ProcessId -ne $AppProcessId) { continue }
                $windowTitle = $window.Current.Name
                if ($null -eq $screenshotWindow -or (-not $screenshotMatchesButton -and $screenshotWindow.Current.IsOffscreen -and -not $window.Current.IsOffscreen)) {
                    $screenshotWindow = $window
                }
                $buttons = @()
                if ($null -ne $buttonCondition) {
                    $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
                }
                foreach ($button in $buttons) {
                    if ($button.Current.ProcessId -ne $AppProcessId) { continue }
                    if (-not $window.Current.IsOffscreen) {
                        $screenshotWindow = $window
                        $screenshotMatchesButton = $true
                    }
                    # InspectOnly never requests or invokes an action pattern.
                    if ($InspectOnly) { continue }
                    if (-not $button.Current.IsEnabled -or $button.Current.IsOffscreen) { continue }
                    [object]$invokeObject = $null
                    if (-not $button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokeObject)) { continue }
                    $screenshot = Save-WindowScreenshot $window
                    if (-not (Test-TargetProcess)) {
                        Write-Result @{ clicked = $false; pid = $AppProcessId; name = $ButtonName; error = 'The requested process changed before invocation.'; screenshot = $screenshot } 3
                    }
                    if ($window.Current.ProcessId -ne $AppProcessId -or $button.Current.ProcessId -ne $AppProcessId -or $button.Current.Name -cne $ButtonName -or $button.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or -not $button.Current.IsEnabled -or $button.Current.IsOffscreen) { continue }
                    ([System.Windows.Automation.InvokePattern]$invokeObject).Invoke()
                    Write-Result @{ clicked = $true; inspected = $false; pid = $AppProcessId; name = $ButtonName; windowTitle = $windowTitle; screenshot = $screenshot; elapsedMs = $clock.ElapsedMilliseconds } 0
                }
                $diagnostic = Get-WindowDiagnostic $window
                if ($null -ne $diagnostic) { $lastWindows += $diagnostic }
            } catch [System.Windows.Automation.ElementNotAvailableException] {
                $lastFailure = 'A target window changed while being inspected.'
            } catch [System.InvalidOperationException] {
                $lastFailure = $_.Exception.Message
            }
        }
        if ($InspectOnly -and $lastWindows.Count -gt 0) {
            $screenshot = Save-WindowScreenshot $screenshotWindow
            Write-Result @{ clicked = $false; inspected = $true; pid = $AppProcessId; name = $ButtonName; windows = $lastWindows; screenshot = $screenshot; lastFailure = $lastFailure; elapsedMs = $clock.ElapsedMilliseconds } 0
        }
        Start-Sleep -Milliseconds 200
    }
    $screenshot = $null
    if ($null -ne $screenshotWindow) { $screenshot = Save-WindowScreenshot $screenshotWindow }
    Write-Result @{ clicked = $false; inspected = $false; pid = $AppProcessId; name = $ButtonName; error = 'Timed out waiting for the requested native button or process window.'; lastFailure = $lastFailure; windows = $lastWindows; screenshot = $screenshot; elapsedMs = $clock.ElapsedMilliseconds } 2
} catch {
    Write-Result @{ clicked = $false; inspected = $false; pid = $AppProcessId; name = $ButtonName; error = $_.Exception.Message; errorType = $_.Exception.GetType().FullName } 1
}
