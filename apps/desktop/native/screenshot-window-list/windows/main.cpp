#include <windows.h>
#include <dwmapi.h>
#include <shobjidl.h>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

struct WindowRect {
  unsigned long long id;
  long x;
  long y;
  long width;
  long height;
};

struct EnumState {
  std::vector<std::uintptr_t> excludedWindowIds;
  std::vector<WindowRect> windows;
};

BOOL CALLBACK collectWindow(HWND window, LPARAM value) {
  auto* state = reinterpret_cast<EnumState*>(value);
  if (!IsWindowVisible(window) || IsIconic(window)) return TRUE;
  const auto id = reinterpret_cast<std::uintptr_t>(window);
  if (std::find(state->excludedWindowIds.begin(), state->excludedWindowIds.end(), id) != state->excludedWindowIds.end()) return TRUE;
  if (window == GetDesktopWindow() || window == GetShellWindow()) return TRUE;
  wchar_t className[256]{};
  GetClassNameW(window, className, 256);
  const std::wstring name(className);
  if (name == L"Progman" || name == L"WorkerW" || name == L"Shell_TrayWnd" || name == L"Shell_SecondaryTrayWnd") return TRUE;
  const auto style = GetWindowLongPtr(window, GWL_EXSTYLE);
  if ((style & WS_EX_TRANSPARENT) != 0 && (style & WS_EX_LAYERED) != 0) return TRUE;
  DWORD cloaked = 0;
  if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0) return TRUE;
  RECT rect{};
  if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect)))) {
    if (!GetWindowRect(window, &rect)) return TRUE;
  }
  const long width = rect.right - rect.left;
  const long height = rect.bottom - rect.top;
  if (width < 8 || height < 8) return TRUE;
  state->windows.push_back({id, rect.left, rect.top, width, height});
  return TRUE;
}

std::string rectJson(const RECT& rect) {
  return "{\"x\":" + std::to_string(rect.left) + ",\"y\":" + std::to_string(rect.top)
       + ",\"width\":" + std::to_string(rect.right - rect.left)
       + ",\"height\":" + std::to_string(rect.bottom - rect.top) + '}';
}

bool parseCoordinate(const char* argument, long& value) {
  char* end = nullptr;
  errno = 0;
  const auto parsed = std::strtol(argument, &end, 10);
  if (end == argument || *end != '\0' || errno == ERANGE) return false;
  value = parsed;
  return true;
}

bool monitorRect(HMONITOR monitor, RECT& rect) {
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  if (monitor == nullptr || !GetMonitorInfoW(monitor, &info)) return false;
  rect = info.rcMonitor;
  return true;
}

int placeOverlay(HWND window, const char* xArgument, const char* yArgument, RECT& monitor) {
  POINT anchor{};
  if (!parseCoordinate(xArgument, anchor.x) || !parseCoordinate(yArgument, anchor.y)) {
    std::cerr << "invalid-monitor-anchor";
    return 1;
  }
  if (!monitorRect(MonitorFromPoint(anchor, MONITOR_DEFAULTTONULL), monitor)) {
    std::cerr << "overlay-monitor-missing:" << anchor.x << ',' << anchor.y;
    return 1;
  }
  if (!SetWindowPos(window, nullptr, monitor.left, monitor.top, monitor.right - monitor.left, monitor.bottom - monitor.top,
                    SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING)) {
    std::cerr << "overlay-placement-failed:" << GetLastError();
    return 1;
  }
  RECT placed{};
  if (!GetWindowRect(window, &placed) || !EqualRect(&placed, &monitor)) {
    std::cerr << "overlay-bounds-mismatch:window=" << rectJson(placed) << ",monitor=" << rectJson(monitor);
    return 1;
  }
  return 0;
}

int configureOverlay(char** argv, bool inspect) {
  char* end = nullptr;
  const auto handle = std::strtoull(argv[2], &end, 10);
  if (handle == 0 || end == argv[2] || *end != '\0') return 1;
  const auto window = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(handle));
  if (!IsWindow(window)) {
    std::cerr << "invalid-window";
    return 1;
  }
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid != std::strtoul(argv[3], nullptr, 10)) {
    std::cerr << "window-owner-mismatch";
    return 1;
  }
  const auto style = GetWindowLongPtr(window, GWL_STYLE);
  if (inspect) {
    RECT rect{};
    RECT monitor{};
    if (!GetWindowRect(window, &rect) || !monitorRect(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), monitor)) return 1;
    const POINT point{(rect.left + rect.right) / 2, rect.bottom - 2};
    const HWND top = GetAncestor(WindowFromPoint(point), GA_ROOT);
    char name[256]{};
    GetClassNameA(top, name, sizeof(name));
    std::cout << "{\"covered\":" << (top == window ? "true" : "false")
              << ",\"foreground\":" << (GetForegroundWindow() == window ? "true" : "false")
              << ",\"exStyle\":" << GetWindowLongPtr(window, GWL_EXSTYLE)
              << ",\"topClass\":\"" << name << "\",\"style\":" << style
              << ",\"window\":" << rectJson(rect) << ",\"monitor\":" << rectJson(monitor) << '}';
    return 0;
  }
  if ((style & (WS_CAPTION | WS_THICKFRAME)) != 0) {
    std::cerr << "overlay-frame-style-present:" << style;
    return 1;
  }
  RECT monitor{};
  if (placeOverlay(window, argv[4], argv[5], monitor) != 0) return 1;
  const BOOL disabled = TRUE;
  const HRESULT transition = DwmSetWindowAttribute(window, DWMWA_TRANSITIONS_FORCEDISABLED, &disabled, sizeof(disabled));
  if (FAILED(transition)) {
    std::cerr << "dwm-set-failed:" << transition;
    return 1;
  }
  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(initialized)) {
    std::cerr << "com-init-failed:" << initialized;
    return 1;
  }
  ITaskbarList2* taskbarList = nullptr;
  HRESULT fullscreen = CoCreateInstance(CLSID_TaskbarList, nullptr, CLSCTX_ALL, IID_PPV_ARGS(&taskbarList));
  if (SUCCEEDED(fullscreen)) {
    fullscreen = taskbarList->HrInit();
    if (SUCCEEDED(fullscreen)) fullscreen = taskbarList->MarkFullscreenWindow(window, TRUE);
    taskbarList->Release();
  }
  CoUninitialize();
  if (FAILED(fullscreen)) {
    std::cerr << "taskbar-fullscreen-failed:" << fullscreen;
    return 1;
  }
  std::cout << "{\"ok\":true,\"style\":" << style << ",\"transitionResult\":" << transition
            << ",\"fullscreenResult\":" << fullscreen << ",\"monitor\":" << rectJson(monitor) << '}';
  return 0;
}

int main(int argc, char** argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (argc > 1 && std::string(argv[1]) == "configure") return argc == 6 ? configureOverlay(argv, false) : 1;
  if (argc > 1 && std::string(argv[1]) == "inspect") return argc == 4 ? configureOverlay(argv, true) : 1;
  EnumState state{};
  for (int index = 1; index < argc; ++index) {
    state.excludedWindowIds.push_back(static_cast<std::uintptr_t>(std::strtoull(argv[index], nullptr, 10)));
  }
  EnumWindows(collectWindow, reinterpret_cast<LPARAM>(&state));
  std::cout << "{\"units\":\"pixels\",\"windows\":[";
  for (size_t index = 0; index < state.windows.size(); ++index) {
    const auto& item = state.windows[index];
    if (index > 0) std::cout << ',';
    std::cout << "{\"id\":\"" << item.id << "\",\"x\":" << item.x << ",\"y\":" << item.y
              << ",\"width\":" << item.width << ",\"height\":" << item.height << '}';
  }
  std::cout << "]}";
  return 0;
}
