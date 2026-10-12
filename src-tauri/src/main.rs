use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// 两次锁屏之间的连续解锁时长。每满一个 interval 提醒一次，锁屏后清零。
/// ponytail: 只从本进程看到解锁的那一刻起算，重启应用会重新计时。要跨重启续上，把 unlocked_since 写到本地文件。
struct BreakClock {
    unlocked_since: Option<Instant>,
    sent: u64,
    interval: Duration,
}

impl BreakClock {
    fn new(interval: Duration) -> Self {
        Self {
            unlocked_since: None,
            sent: 0,
            interval,
        }
    }

    /// 第几次提醒（从 1 起）。未到点或当前锁屏返回 None。
    fn poll(&mut self, unlocked: bool, now: Instant) -> Option<u64> {
        if !unlocked || self.interval.is_zero() {
            self.unlocked_since = None;
            self.sent = 0;
            return None;
        }
        let since = *self.unlocked_since.get_or_insert(now);
        let due = now.saturating_duration_since(since).as_secs() / self.interval.as_secs();
        if due > self.sent {
            self.sent = due;
            Some(due)
        } else {
            None
        }
    }

    /// 改间隔时按已经解锁的时长对齐，不把已经过去的档位补发一遍。
    fn set_interval(&mut self, interval: Duration, now: Instant) {
        if interval.is_zero() || interval == self.interval {
            return;
        }
        self.interval = interval;
        if let Some(since) = self.unlocked_since {
            self.sent = now.saturating_duration_since(since).as_secs() / interval.as_secs();
        }
    }
}

/// 当前会话是否解锁。None 表示查询失败，调用方应保持上一轮计时。
/// 锁屏时会话往往仍是 WTSActive，要看 SessionFlags（本机解锁时实测为 1）。
#[cfg(windows)]
fn session_unlocked() -> Option<bool> {
    use windows::Win32::System::RemoteDesktop::{
        WTSFreeMemory, WTSQuerySessionInformationW, WTSINFOEXW, WTSSessionInfoEx,
        WTS_CURRENT_SESSION, WTS_SESSIONSTATE_UNLOCK,
    };
    use windows::core::PWSTR;

    unsafe {
        let mut buf = PWSTR::null();
        let mut bytes = 0u32;
        let ok = WTSQuerySessionInformationW(
            None,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buf,
            &mut bytes,
        );
        if ok.is_err() || buf.is_null() || (bytes as usize) < std::mem::size_of::<WTSINFOEXW>() {
            if !buf.is_null() {
                WTSFreeMemory(buf.as_ptr().cast());
            }
            return None;
        }
        let flags = (*buf.as_ptr().cast::<WTSINFOEXW>())
            .Data
            .WTSInfoExLevel1
            .SessionFlags;
        WTSFreeMemory(buf.as_ptr().cast());
        Some(flags == WTS_SESSIONSTATE_UNLOCK as i32)
    }
}

// 后台线程: 按 config.json 的 breakMinutes 提醒，锁屏后重新计时
// ponytail: 每 15 秒读一次文件。要更快生效就改成监听文件。
#[cfg(windows)]
fn start_break_reminder(app: tauri::AppHandle) {
    use tauri_plugin_notification::NotificationExt;

    std::thread::spawn(move || {
        let mut minutes = read_break_minutes().unwrap_or(30);
        let mut clock = BreakClock::new(Duration::from_secs(minutes * 60));
        let mut logged_query_fail = false;
        loop {
            if let Some(n) = read_break_minutes() {
                if n != minutes {
                    minutes = n;
                    clock.set_interval(Duration::from_secs(minutes * 60), Instant::now());
                }
            }
            match session_unlocked() {
                Some(unlocked) => {
                    logged_query_fail = false;
                    if let Some(n) = clock.poll(unlocked, Instant::now()) {
                        let used = n * minutes;
                        if let Err(e) = app
                            .notification()
                            .builder()
                            .title("番茄 AI")
                            .body(format!(
                                "已连续使用电脑 {used} 分钟, 起来活动一下吧!"
                            ))
                            .show()
                        {
                            eprintln!("[pomodoro] 休息提醒发送失败: {e}");
                        }
                    }
                }
                None => {
                    if !logged_query_fail {
                        eprintln!("[pomodoro] 读取锁屏状态失败, 本轮跳过");
                        logged_query_fail = true;
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(15));
        }
    });
}

#[cfg(not(windows))]
fn start_break_reminder(_app: tauri::AppHandle) {}

/// config.json 里的休息间隔（分钟）。缺字段或读失败返回 None，调用方沿用当前值。
fn read_break_minutes() -> Option<u64> {
    let text = std::fs::read_to_string(locate_server()?.join("config.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let n = v.get("breakMinutes")?.as_u64()?;
    (1..=24 * 60).contains(&n).then_some(n)
}

fn port() -> u16 {
    std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(3000)
}

// 从 exe 所在目录逐级向上, 找到含 server.js 的项目根目录
fn locate_server() -> Option<PathBuf> {
    let start = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let mut cur = Some(start.clone());
    while let Some(dir) = cur {
        let cand = dir.join("server.js");
        if cand.exists() {
            return Some(dir);
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
    // 回退: 当前工作目录
    let cwd = std::env::current_dir().ok()?;
    if cwd.join("server.js").exists() {
        return Some(cwd);
    }
    None
}

fn spawn_node_server(p: u16) -> std::io::Result<std::process::Child> {
    let dir = locate_server().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "找不到 server.js")
    })?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        return std::process::Command::new("node")
            .arg("server.js")
            .current_dir(&dir)
            .env("PORT", p.to_string())
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("node")
            .arg("server.js")
            .current_dir(&dir)
            .env("PORT", p.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }
}

/// 最小化前的窗口尺寸和位置。compact 为真时不要把小窗尺寸写回来。
struct Frame {
    compact: bool,
    size: Option<(u32, u32)>,
    pos: Option<(i32, i32)>,
}

fn restore_full(window: &tauri::WebviewWindow) {
    let state = window.state::<Mutex<Frame>>();
    let mut frame = state.lock().unwrap();
    if !frame.compact {
        return;
    }
    frame.compact = false;
    let size = frame.size;
    let pos = frame.pos;
    drop(frame);
    let _ = window.set_always_on_top(false);
    let _ = window.set_decorations(true);
    let _ = window.set_resizable(true);
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(440.0, 680.0)));
    let scale = window.scale_factor().unwrap_or(1.0);
    let big_enough = size.is_some_and(|(w, h)| {
        w as f64 >= 440.0 * scale && h as f64 >= 680.0 * scale
    });
    if let Some((w, h)) = size.filter(|_| big_enough) {
        let _ = window.set_size(tauri::PhysicalSize::new(w, h));
    } else {
        let _ = window.set_size(tauri::LogicalSize::new(520.0, 760.0));
    }
    if let Some((x, y)) = pos {
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

fn enter_compact(window: &tauri::WebviewWindow) {
    {
        let state = window.state::<Mutex<Frame>>();
        let mut frame = state.lock().unwrap();
        if frame.compact {
            return;
        }
        if let Ok(size) = window.inner_size() {
            let scale = window.scale_factor().unwrap_or(1.0);
            if size.width as f64 >= 440.0 * scale && size.height as f64 >= 680.0 * scale {
                frame.size = Some((size.width, size.height));
            }
        }
        if let Ok(pos) = window.outer_position() {
            if pos.x > -10_000 && pos.y > -10_000 {
                frame.pos = Some((pos.x, pos.y));
            }
        }
        frame.compact = true;
    }
    let _ = window.set_always_on_top(true);
    let _ = window.set_decorations(false);
    let _ = window.set_resizable(false);
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(64.0, 28.0)));
    if let Err(e) = window.set_size(tauri::LogicalSize::new(108.0, 40.0)) {
        eprintln!("[pomodoro] 缩小窗口失败: {e}");
    }
    let _ = window.unminimize();
    let _ = window.show();
}

#[tauri::command]
fn restore_window(window: tauri::WebviewWindow) {
    restore_full(&window);
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn fit_compact(window: tauri::WebviewWindow, width: f64, height: f64) {
    let compact = {
        let state = window.state::<Mutex<Frame>>();
        let compact = state.lock().unwrap().compact;
        compact
    };
    if !compact {
        return;
    }
    let width = width.clamp(64.0, 240.0);
    let height = height.clamp(28.0, 56.0);
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
}

#[tauri::command]
fn drag_window(window: tauri::WebviewWindow) {
    if let Err(e) = window.start_dragging() {
        eprintln!("[pomodoro] 拖动小窗失败: {e}");
    }
}

// Tauri 没有「即将最小化」事件，点标题栏最小化时窗口已经进任务栏。
// 这里在消息到达系统之前拦住 SC_MINIMIZE。
#[cfg(windows)]
fn install_minimize_hook(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, GetAncestor, SetWindowLongPtrW, GA_ROOT, GWLP_WNDPROC, SC_MINIMIZE,
        WM_SYSCOMMAND, WNDPROC,
    };

    static PREV: AtomicIsize = AtomicIsize::new(0);
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    let _ = APP.set(app.clone());

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_SYSCOMMAND && (wparam.0 as u32) & 0xFFF0 == SC_MINIMIZE {
            if let Some(app) = APP.get() {
                let app = app.clone();
                let moved = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(w) = moved.get_webview_window("main") {
                        enter_compact(&w);
                    }
                });
            }
            return LRESULT(0);
        }
        let prev = PREV.load(Ordering::Relaxed);
        if prev == 0 {
            return LRESULT(0);
        }
        let prev_fn: WNDPROC = unsafe { std::mem::transmute(prev) };
        unsafe { CallWindowProcW(prev_fn, hwnd, msg, wparam, lparam) }
    }

    let Ok(hwnd) = window.hwnd() else {
        eprintln!("[pomodoro] 拿不到窗口句柄, 最小化不会变成小窗");
        return;
    };
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let target = if root.0.is_null() { hwnd } else { root };
    let prev = unsafe {
        SetWindowLongPtrW(target, GWLP_WNDPROC, proc as *const () as usize as isize)
    };
    PREV.store(prev, Ordering::Relaxed);
}

#[cfg(not(windows))]
fn install_minimize_hook(_app: &tauri::AppHandle, _window: &tauri::WebviewWindow) {}

fn main() {
    let p = port();
    let addr = format!("127.0.0.1:{p}");

    tauri::Builder::default()
        .manage(Mutex::new(Frame {
            compact: false,
            size: None,
            pos: None,
        }))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![restore_window, drag_window, fit_compact])
        .setup(move |app| {
            let handle = app.handle().clone();
            start_break_reminder(handle.clone());

            std::thread::spawn(move || {
                if TcpStream::connect(&addr).is_err() {
                    match spawn_node_server(p) {
                        Ok(_) => eprintln!("[pomodoro] 已启动 node 服务 ({addr})"),
                        Err(e) => {
                            eprintln!("[pomodoro] 启动 node 服务失败: {e}");
                            return;
                        }
                    }
                }
                for _ in 0..200 {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    if TcpStream::connect(&addr).is_ok() {
                        eprintln!("[pomodoro] 服务就绪 ({addr})");
                        return;
                    }
                }
                eprintln!("[pomodoro] 服务 10 秒内未就绪，请确认 node 可用");
            });

            if let Some(w) = app.get_webview_window("main") {
                install_minimize_hook(app.handle(), &w);
            }

            let show = MenuItem::with_id(&handle, "show", "显示窗口", true, None::<&str>)?;
            let hide = MenuItem::with_id(&handle, "hide", "隐藏窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(&handle, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(&handle, &[&show, &hide, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            restore_full(&w);
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Resized(size) => {
                if size.width > 320 && size.height > 200 {
                    let state = window.state::<Mutex<Frame>>();
                    let mut frame = state.lock().unwrap();
                    if !frame.compact {
                        frame.size = Some((size.width, size.height));
                    }
                }
            }
            WindowEvent::Moved(pos) => {
                if pos.x > -10_000 && pos.y > -10_000 {
                    let state = window.state::<Mutex<Frame>>();
                    let mut frame = state.lock().unwrap();
                    if !frame.compact {
                        frame.pos = Some((pos.x, pos.y));
                    }
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reminds_once_per_interval_until_lock() {
        let start = Instant::now();
        let mut clock = BreakClock::new(Duration::from_secs(60));
        assert_eq!(clock.poll(true, start), None);
        assert_eq!(clock.poll(true, start + Duration::from_secs(59)), None);
        assert_eq!(clock.poll(true, start + Duration::from_secs(60)), Some(1));
        assert_eq!(clock.poll(true, start + Duration::from_secs(119)), None);
        assert_eq!(clock.poll(true, start + Duration::from_secs(180)), Some(3));
        assert_eq!(clock.poll(false, start + Duration::from_secs(181)), None);
        let again = start + Duration::from_secs(200);
        assert_eq!(clock.poll(true, again), None);
        assert_eq!(clock.poll(true, again + Duration::from_secs(60)), Some(1));
    }

    #[test]
    fn changing_interval_skips_elapsed_slots() {
        let start = Instant::now();
        let mut clock = BreakClock::new(Duration::from_secs(30));
        assert_eq!(clock.poll(true, start), None);
        assert_eq!(clock.poll(true, start + Duration::from_secs(30)), Some(1));
        clock.set_interval(Duration::from_secs(60), start + Duration::from_secs(40));
        assert_eq!(clock.poll(true, start + Duration::from_secs(40)), None);
        assert_eq!(clock.poll(true, start + Duration::from_secs(60)), Some(1));
    }

    #[cfg(windows)]
    #[test]
    fn session_query_returns_a_state() {
        assert!(
            session_unlocked().is_some(),
            "WTSQuerySessionInformationW 失败, WTSINFOEXW={}",
            std::mem::size_of::<windows::Win32::System::RemoteDesktop::WTSINFOEXW>()
        );
    }
}
