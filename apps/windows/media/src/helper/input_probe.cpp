#include <windows.h>

#include <cstdio>
#include <initializer_list>
#include <string>

namespace {

constexpr int kIdButton = 101;
constexpr int kIdEdit = 102;
constexpr int kIdList = 103;

HWND g_status = nullptr;
HWND g_edit = nullptr;
WNDPROC g_orig_edit_proc = nullptr;
int g_clicks = 0;
int g_wheel = 0;
wchar_t g_last_key[64] = L"none";

void UpdateStatusText() {
  if (!g_status) return;
  wchar_t buf[256] = {};
  std::swprintf(buf, ARRAYSIZE(buf), L"Clicks: %d; Wheel: %d; Key: %ls", g_clicks, g_wheel, g_last_key);
  SetWindowTextW(g_status, buf);
}

LRESULT CALLBACK EditSubclassProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
    LONG scan = static_cast<LONG>((lp >> 16) & 0x1FF) << 16;
    if (!GetKeyNameTextW(scan, g_last_key, ARRAYSIZE(g_last_key))) {
      std::swprintf(g_last_key, ARRAYSIZE(g_last_key), L"VK_%u", static_cast<unsigned>(wp));
    }
    UpdateStatusText();
  }
  return CallWindowProcW(g_orig_edit_proc, hwnd, msg, wp, lp);
}

LRESULT CALLBACK ProbeWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_CREATE: {
      HFONT font = CreateFontW(-18, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                               OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_DONTCARE, L"Microsoft YaHei UI");
      HWND header = CreateWindowExW(0, L"STATIC", L"Isolated remote input test",
                                    WS_CHILD | WS_VISIBLE, 30, 20, 680, 35, hwnd, nullptr, nullptr, nullptr);
      g_edit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                               WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_AUTOVSCROLL | WS_VSCROLL,
                               30, 65, 680, 90, hwnd, reinterpret_cast<HMENU>(static_cast<intptr_t>(kIdEdit)), nullptr, nullptr);
      HWND btn = CreateWindowExW(0, L"BUTTON", L"Test click",
                                 WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                                 30, 165, 200, 40, hwnd, reinterpret_cast<HMENU>(static_cast<intptr_t>(kIdButton)), nullptr, nullptr);
      g_status = CreateWindowExW(0, L"STATIC", L"Clicks: 0; Wheel: 0; Key: none",
                                 WS_CHILD | WS_VISIBLE, 30, 210, 680, 70, hwnd, nullptr, nullptr, nullptr);
      HWND list = CreateWindowExW(WS_EX_CLIENTEDGE, L"LISTBOX", L"",
                                  WS_CHILD | WS_VISIBLE | WS_VSCROLL | LBS_NOTIFY,
                                  30, 290, 680, 260, hwnd, reinterpret_cast<HMENU>(static_cast<intptr_t>(kIdList)), nullptr, nullptr);
      for (HWND child : {header, g_edit, btn, g_status, list}) {
        if (child && font) SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
      }
      for (int i = 0; i < 100; ++i) {
        wchar_t row[64] = {};
        std::swprintf(row, ARRAYSIZE(row), L"Scroll row %d", i);
        SendMessageW(list, LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(row));
      }
      if (g_edit) {
        g_orig_edit_proc = reinterpret_cast<WNDPROC>(
            SetWindowLongPtrW(g_edit, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(EditSubclassProc)));
      }
      return 0;
    }
    case WM_COMMAND:
      if (LOWORD(wp) == kIdButton && HIWORD(wp) == BN_CLICKED) {
        g_clicks += 1;
        UpdateStatusText();
      }
      return 0;
    case WM_MOUSEWHEEL:
      g_wheel += GET_WHEEL_DELTA_WPARAM(wp);
      UpdateStatusText();
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int show_cmd) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = ProbeWndProc;
  wc.hInstance = inst;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  wc.lpszClassName = L"LinkShellInputProbeWindow";
  RegisterClassExW(&wc);

  RECT rc{0, 0, 760, 600};
  AdjustWindowRect(&rc, WS_OVERLAPPEDWINDOW, FALSE);
  int w = rc.right - rc.left;
  int h = rc.bottom - rc.top;
  int sx = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
  int sy = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;

  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"LinkShell Input QA", WS_OVERLAPPEDWINDOW,
                              sx, sy, w, h, nullptr, nullptr, inst, nullptr);
  if (!hwnd) return 1;
  ShowWindow(hwnd, show_cmd);
  UpdateWindow(hwnd);

  MSG msg{};
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return static_cast<int>(msg.wParam);
}
