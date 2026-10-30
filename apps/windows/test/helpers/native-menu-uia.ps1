# Windows PowerShell 5.1 reads this file as UTF-8 with BOM so exact Chinese names survive.
[CmdletBinding(DefaultParameterSetName = 'Invoke')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$AppProcessId,

    [Parameter(Mandatory = $true, ParameterSetName = 'Invoke')]
    [Parameter(ParameterSetName = 'Inspect')]
    [ValidateSet('复制', '剪切', '粘贴', '撤销')]
    [string]$MenuItemName,

    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30,

    [string]$DumpPath,

    [Parameter(Mandatory = $true, ParameterSetName = 'Inspect')]
    [switch]$InspectOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$helperClock = [System.Diagnostics.Stopwatch]::StartNew()
$phase = 'starting'
$processStart = $null
$knownNames = @('复制', '剪切', '粘贴', '撤销')
$lastWindows = @()
$lastMenus = @()
$candidateEvidence = $null
$startupMs = $null

function Write-Dump {
    param([hashtable]$Value)
    $Value['pid'] = $AppProcessId
    $Value['name'] = $MenuItemName
    $Value['elapsedMs'] = $helperClock.ElapsedMilliseconds
    $Value['startupMs'] = $startupMs
    $Value['phase'] = $phase
    $Value['windows'] = $lastWindows
    $Value['menus'] = $lastMenus
    $Value['candidate'] = $candidateEvidence
    $json = $Value | ConvertTo-Json -Depth 8 -Compress
    if ($DumpPath) {
        $path = [System.IO.Path]::GetFullPath($DumpPath)
        $directory = [System.IO.Path]::GetDirectoryName($path)
        if ($directory) { [System.IO.Directory]::CreateDirectory($directory) | Out-Null }
        [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
    }
    return $json
}

function Write-Result {
    param([hashtable]$Value, [int]$ExitCode)
    try { $json = Write-Dump $Value }
    catch {
        $Value['dumpFailed'] = $true
        $Value['dumpErrorType'] = $_.Exception.GetType().FullName
        if ($ExitCode -eq 0) { $ExitCode = 1; $Value['failed'] = $true }
        $json = $Value | ConvertTo-Json -Depth 8 -Compress
    }
    [Console]::Out.WriteLine($json)
    exit $ExitCode
}

function Test-TargetProcess {
    $live = Get-Process -Id $AppProcessId -ErrorAction SilentlyContinue
    if (-not $live) { return $false }
    try { return $live.StartTime.ToUniversalTime().Ticks -eq $processStart }
    catch { return $false }
    finally { $live.Dispose() }
}

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    Write-Result @{ clicked = $false; inspected = $false; failed = $true; error = 'Windows GitHub Actions runner required.' } 4
}

try {
    $initial = Get-Process -Id $AppProcessId -ErrorAction Stop
    $processStart = $initial.StartTime.ToUniversalTime().Ticks
    $initial.Dispose()
    $phase = 'loading-uia'
    Write-Dump @{ clicked = $false; inspected = $false } | Out-Null
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName WindowsBase
    Add-Type -AssemblyName Accessibility
    Add-Type -ReferencedAssemblies @([Accessibility.IAccessible].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;

public static class LinkShellCiNativeMenuWindow
{
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint owner);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetClassNameW(IntPtr window, StringBuilder name, int capacity);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", ExactSpelling = true)]
    private static extern int GetWindowLong(IntPtr window, int index);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);

    [DllImport("oleacc.dll")]
    private static extern int WindowFromAccessibleObject([MarshalAs(UnmanagedType.Interface)] IAccessible accessible, out IntPtr window);

    [DllImport("oleacc.dll")]
    private static extern int AccessibleChildren([MarshalAs(UnmanagedType.Interface)] IAccessible accessible, int start, int count,
        [Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.Struct, SizeParamIndex = 2)] object[] children, out int obtained);

    public static bool IsOwned(IntPtr window, int expectedProcessId)
    {
        uint owner;
        return window != IntPtr.Zero && IsWindow(window)
            && GetWindowThreadProcessId(window, out owner) != 0 && owner == (uint)expectedProcessId;
    }

    public static string WindowClass(IntPtr window, int expectedProcessId)
    {
        if (!IsOwned(window, expectedProcessId)) return null;
        var name = new StringBuilder(256);
        return GetClassNameW(window, name, name.Capacity) == 0 ? null : name.ToString();
    }

    public static bool IsPopup(IntPtr window, int expectedProcessId)
    {
        return IsOwned(window, expectedProcessId) && IsWindowVisible(window)
            && (unchecked((uint)GetWindowLong(window, -16)) & 0x80000000U) != 0;
    }

    public static bool HasOwnedParent(IntPtr window, int expectedProcessId)
    {
        return IsOwned(GetWindow(window, 4), expectedProcessId); // GW_OWNER
    }

    private sealed class Candidate
    {
        public IAccessible Accessible;
        public object Child;
    }

    private static Dictionary<string, object> Describe(Candidate candidate, IntPtr window, int processId, string name, double[] bounds)
    {
        IntPtr actualWindow;
        if (!IsPopup(window, processId) || WindowFromAccessibleObject(candidate.Accessible, out actualWindow) < 0
            || actualWindow != window || !IsOwned(actualWindow, processId)) return null;
        IAccessible accessible = candidate.Accessible;
        object child = candidate.Child;
        object role = accessible.get_accRole(child), stateValue = accessible.get_accState(child);
        if (accessible.get_accName(child) != name || !(role is int) || (int)role != 12 || !(stateValue is int)) return null;
        int state = (int)stateValue;
        int x, y, width, height;
        accessible.accLocation(out x, out y, out width, out height, child);
        // Bounds tie the MSAA identity to the exact UIA MenuItem; no coordinate action is used.
        if (bounds == null || bounds.Length != 4) return null;
        foreach (double value in bounds) if (Double.IsNaN(value) || Double.IsInfinity(value)) return null;
        if (width <= 0 || height <= 0 || bounds[2] <= 0 || bounds[3] <= 0
            || Math.Abs(x - bounds[0]) > 2 || Math.Abs(y - bounds[1]) > 2
            || Math.Abs(width - bounds[2]) > 2 || Math.Abs(height - bounds[3]) > 2) return null;
        string action = accessible.get_accDefaultAction(child);
        return new Dictionary<string, object> {
            { "source", "MSAA" }, { "name", name }, { "role", 12 }, { "state", state },
            { "defaultAction", action }, { "ownerPid", processId }, { "nativeHandle", actualWindow.ToInt64() },
            { "bounds", new int[] { x, y, width, height } },
            { "canInvoke", (state & (1 | 0x8000 | 0x10000)) == 0 && !String.IsNullOrWhiteSpace(action) }
        };
    }

    private static void Walk(IAccessible accessible, int depth, ref int budget, List<IAccessible> references,
        List<Candidate> matches, IntPtr window, int processId, string name, double[] bounds)
    {
        if (depth > 6 || budget-- <= 0 || matches.Count > 1) return;
        IntPtr actualWindow;
        if (WindowFromAccessibleObject(accessible, out actualWindow) < 0 || actualWindow != window || !IsOwned(actualWindow, processId)) return;
        var self = new Candidate { Accessible = accessible, Child = 0 };
        if (Describe(self, window, processId, name, bounds) != null) matches.Add(self);
        int count = Math.Min(Math.Max(0, accessible.accChildCount), Math.Min(64, Math.Max(0, budget)));
        if (count == 0) return;
        object[] children = new object[count];
        int obtained;
        Marshal.ThrowExceptionForHR(AccessibleChildren(accessible, 0, count, children, out obtained));
        foreach (object value in children) { var reference = value as IAccessible; if (reference != null) references.Add(reference); }
        for (int index = 0; index < obtained && budget > 0 && matches.Count < 2; index++) {
            var nested = children[index] as IAccessible;
            if (nested != null) Walk(nested, depth + 1, ref budget, references, matches, window, processId, name, bounds);
            else if (children[index] is int) {
                budget--;
                var candidate = new Candidate { Accessible = accessible, Child = children[index] };
                if (Describe(candidate, window, processId, name, bounds) != null) matches.Add(candidate);
            }
        }
    }

    public static Dictionary<string, object> MenuAction(IntPtr window, int processId, string name, double[] bounds, bool invoke)
    {
        if (!IsPopup(window, processId)) throw new InvalidOperationException("The popup is no longer owned by the target process.");
        foreach (uint objectId in new uint[] { unchecked((uint)-4), 0 }) {
            var iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
            IAccessible root;
            int result = AccessibleObjectFromWindow(window, objectId, ref iid, out root);
            if (result < 0 || root == null) continue;
            var references = new List<IAccessible> { root };
            try {
                int budget = 128;
                var matches = new List<Candidate>();
                Walk(root, 0, ref budget, references, matches, window, processId, name, bounds);
                if (matches.Count > 1) throw new InvalidOperationException("More than one native menu item matches the UIA identity.");
                if (matches.Count == 0) continue;
                var evidence = Describe(matches[0], window, processId, name, bounds);
                if (invoke) {
                    if (evidence == null || !(bool)evidence["canInvoke"]) throw new InvalidOperationException("The native menu default action is not available.");
                    matches[0].Accessible.accDoDefaultAction(matches[0].Child);
                }
                return evidence;
            } finally {
                for (int index = references.Count - 1; index >= 0; index--)
                    if (Marshal.IsComObject(references[index])) { try { Marshal.ReleaseComObject(references[index]); } catch (InvalidComObjectException) {} }
            }
        }
        if (invoke) throw new InvalidOperationException("The native menu item disappeared before invocation.");
        return null;
    }
}
'@
    $ownerCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $AppProcessId)
    $typeCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
    $itemCondition = $typeCondition
    if ($MenuItemName) {
        $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty, $MenuItemName)
        $itemCondition = [System.Windows.Automation.AndCondition]::new($typeCondition, $nameCondition)
    }
    $lastFailure = $null
    $startupMs = $helperClock.ElapsedMilliseconds
    $searchClock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($searchClock.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if (-not (Test-TargetProcess)) {
            Write-Result @{ clicked = $false; inspected = $false; failed = $true; error = 'Target exited or its PID was reused.'; menus = $lastMenus } 3
        }
        $phase = 'finding-menu-windows'
        Write-Dump @{ clicked = $false; inspected = $false } | Out-Null
        # Root Children only; never walk the desktop or the main BrowserWindow descendants.
        $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Children, $ownerCondition)
        $lastMenus = @()
        $lastWindows = @()
        foreach ($root in $roots) {
            try {
                if ($root.Current.ProcessId -ne $AppProcessId) { continue }
                $handle = [IntPtr]::new($root.Current.NativeWindowHandle)
                $nativeClass = [LinkShellCiNativeMenuWindow]::WindowClass($handle, $AppProcessId)
                $popup = [LinkShellCiNativeMenuWindow]::IsPopup($handle, $AppProcessId)
                $ownedParent = [LinkShellCiNativeMenuWindow]::HasOwnedParent($handle, $AppProcessId)
                $explicitMenu = $root.Current.ControlType -eq [System.Windows.Automation.ControlType]::Menu
                $isKnownMenu = $nativeClass -eq '#32768' -or $nativeClass -eq 'Chrome_WidgetWin_2'
                $eligible = $nativeClass -and $popup -and -not $root.Current.IsOffscreen -and ($explicitMenu -or ($nativeClass -ne 'Chrome_WidgetWin_1' -and ($isKnownMenu -or $ownedParent)))
                $rejectionReason = if ($eligible) { $null } elseif (-not $nativeClass) { 'No owned HWND class' }
                    elseif (-not $popup) { 'Not a visible WS_POPUP HWND' } elseif ($root.Current.IsOffscreen) { 'UIA offscreen' }
                    elseif ($nativeClass -eq 'Chrome_WidgetWin_1' -and -not $explicitMenu) { 'BrowserWindow class without Menu semantics' }
                    else { 'No Menu semantics, known popup class or same-process owner' }
                if ($lastWindows.Count -lt 24) {
                    $lastWindows += @{ nativeHandle = $handle.ToInt64(); nativeClass = $nativeClass; controlType = $root.Current.ControlType.ProgrammaticName; offscreen = $root.Current.IsOffscreen; popup = $popup; ownedParent = $ownedParent; searched = $eligible; rejectionReason = $rejectionReason }
                }
                Write-Dump @{ clicked = $false; inspected = $false } | Out-Null
                if (-not $eligible) { continue }
                $diagnostics = @()
                $menuEvidence = @{ nativeHandle = $handle.ToInt64(); nativeClass = $nativeClass; controlType = $root.Current.ControlType.ProgrammaticName; controls = @(); items = $diagnostics }
                $lastMenus += $menuEvidence
                $phase = 'inspecting-menu-controls'
                Write-Dump @{ clicked = $false; inspected = $false } | Out-Null
                # Read only the verified menu subtree; include unexpected control types in failure evidence.
                $controls = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $ownerCondition)
                foreach ($control in $controls) {
                    if ($menuEvidence['controls'].Count -ge 32) { break }
                    $label = $control.Current.Name
                    $safeLabel = if ($knownNames -ccontains $label) { $label } else { '<other control>' }
                    $controlEvidence = @{ name = $safeLabel; controlType = $control.Current.ControlType.ProgrammaticName; enabled = $control.Current.IsEnabled; offscreen = $control.Current.IsOffscreen }
                    $menuEvidence['controls'] += $controlEvidence
                    Write-Dump @{ clicked = $false; inspected = $false } | Out-Null
                    $controlEvidence['patterns'] = @($control.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
                    Write-Dump @{ clicked = $false; inspected = $false } | Out-Null
                }
                $phase = 'finding-menu-item'
                Write-Dump @{ clicked = $false; inspected = $false } | Out-Null
                $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $itemCondition)
                foreach ($item in $items) {
                    if ($item.Current.ProcessId -ne $AppProcessId -or $item.Current.ControlType -ne [System.Windows.Automation.ControlType]::MenuItem) { continue }
                    $itemName = $item.Current.Name
                    if ($MenuItemName -and $itemName -cne $MenuItemName) { continue }
                    # Persist identity before provider calls, so a hung provider still leaves evidence.
                    $safeName = if ($knownNames -ccontains $itemName) { $itemName } else { '<other menu item>' }
                    $candidateEvidence = @{ name = $safeName; controlType = 'ControlType.MenuItem'; nativeHandle = $handle.ToInt64(); nativeClass = $nativeClass; enabled = $item.Current.IsEnabled; offscreen = $item.Current.IsOffscreen }
                    Write-Dump @{ clicked = $false; inspected = $false } | Out-Null
                    $candidateEvidence['patterns'] = @($item.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
                    Write-Dump @{ clicked = $false; inspected = $false } | Out-Null
                    $rectangle = $item.Current.BoundingRectangle
                    $bounds = [double[]]@($rectangle.X, $rectangle.Y, $rectangle.Width, $rectangle.Height)
                    $accessibility = $null
                    if ($knownNames -ccontains $itemName) {
                        try { $accessibility = [LinkShellCiNativeMenuWindow]::MenuAction($handle, $AppProcessId, $itemName, $bounds, $false) }
                        catch { $candidateEvidence['defaultActionErrorType'] = $_.Exception.GetType().FullName }
                    }
                    $candidateEvidence['accessibility'] = $accessibility
                    $candidateEvidence['defaultAction'] = if ($accessibility) { $accessibility['defaultAction'] } else { $null }
                    $candidateEvidence['defaultActionSource'] = 'MSAA'
                    if ($diagnostics.Count -lt 24) { $diagnostics += $candidateEvidence; $menuEvidence['items'] = $diagnostics }
                    Write-Dump @{ clicked = $false; inspected = $false } | Out-Null
                    if ($InspectOnly -or -not $item.Current.IsEnabled -or $item.Current.IsOffscreen) { continue }
                    [object]$invokeObject = $null
                    $method = if ($item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokeObject)) { 'InvokePattern' }
                        elseif ($accessibility -and $accessibility['canInvoke']) { 'MSAA.accDoDefaultAction' } else { $null }
                    if (-not $method) { continue }
                    if (-not (Test-TargetProcess)) {
                        Write-Result @{ clicked = $false; inspected = $false; failed = $true; error = 'Target changed before invocation.' } 3
                    }
                    if (-not [LinkShellCiNativeMenuWindow]::IsPopup($handle, $AppProcessId) -or
                        [LinkShellCiNativeMenuWindow]::WindowClass($handle, $AppProcessId) -cne $nativeClass -or
                        $root.Current.ProcessId -ne $AppProcessId -or $root.Current.IsOffscreen -or
                        $item.Current.ProcessId -ne $AppProcessId -or
                        $item.Current.ControlType -ne [System.Windows.Automation.ControlType]::MenuItem -or
                        $item.Current.Name -cne $MenuItemName -or
                        -not $item.Current.IsEnabled -or $item.Current.IsOffscreen) { continue }
                    $phase = 'invoking-menu-item'
                    $candidateEvidence['invocationMethod'] = $method
                    Write-Dump @{ clicked = $false; inspected = $false; invocationMethod = $method } | Out-Null
                    try {
                        if ($method -eq 'InvokePattern') { ([System.Windows.Automation.InvokePattern]$invokeObject).Invoke() }
                        else {
                            $rectangle = $item.Current.BoundingRectangle
                            $bounds = [double[]]@($rectangle.X, $rectangle.Y, $rectangle.Width, $rectangle.Height)
                            $accessibility = [LinkShellCiNativeMenuWindow]::MenuAction($handle, $AppProcessId, $MenuItemName, $bounds, $true)
                            if (-not $accessibility) { throw [System.InvalidOperationException]::new('The default action returned no invocation evidence.') }
                        }
                    } catch {
                        # A provider can act before throwing; never retry an uncertain edit operation.
                        Write-Result @{ clicked = $false; inspected = $false; failed = $true; actionOutcomeUnknown = $true; invocationMethod = $method; error = 'The native invocation failed; it was not retried.'; errorType = $_.Exception.GetType().FullName } 1
                    }
                    $phase = 'invoked'
                    Write-Result @{ clicked = $true; inspected = $false; failed = $false; invocationMethod = $method; controlType = 'ControlType.MenuItem'; nativeHandle = $handle.ToInt64(); nativeClass = $nativeClass } 0
                }
            } catch [System.Windows.Automation.ElementNotAvailableException] {
                $lastFailure = 'Target menu changed while being inspected.'
            } catch [System.InvalidOperationException] {
                $lastFailure = 'Target menu provider was not ready.'
            }
        }
        if ($InspectOnly -and $lastMenus.Count -gt 0) {
            $phase = 'inspected'
            Write-Result @{ clicked = $false; inspected = $true; failed = $false; menus = $lastMenus } 0
        }
        Start-Sleep -Milliseconds 100
    }
    Write-Result @{ clicked = $false; inspected = $false; failed = $true; error = 'Timed out waiting for the exact native menu item.'; lastFailure = $lastFailure; menus = $lastMenus } 2
} catch {
    Write-Result @{ clicked = $false; inspected = $false; failed = $true; error = 'Native menu UI Automation failed.'; errorType = $_.Exception.GetType().FullName } 1
}
