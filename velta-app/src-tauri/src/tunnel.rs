//! Optional DNS tunnel (Android only).
//!
//! `libsoartunnel.so` (velta-app/soar-tunnel, Go, built by CI into jniLibs)
//! runs a local SOCKS5 proxy that connects directly while the network is
//! normal and through a soar DNS tunnel when the relays are blocked
//! (allowlist-only mobile internet). The core reaches the relays through that
//! proxy via `proxy_url`.
//!
//! Nothing is configured until the user accepts a `velta://tunnel?…` link:
//! the server zone and key never live in this repository. Without the link
//! (or without the library in the APK) the app behaves exactly as upstream.

use serde_json::Value;

#[cfg(target_os = "android")]
mod imp {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int};
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use tauri::Manager;

    use deltachat::config::Config;

    type StrFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
    type StatusFn = unsafe extern "C" fn(c_int) -> *mut c_char;
    type VoidFn = unsafe extern "C" fn();
    type FreeFn = unsafe extern "C" fn(*mut c_char);

    struct Lib {
        _lib: libloading::Library,
        parse: StrFn,
        start: StrFn,
        stop: VoidFn,
        status: StatusFn,
        set_mode: StrFn,
        net_changed: VoidFn,
        free: FreeFn,
    }

    static LIB: OnceLock<Result<Lib, String>> = OnceLock::new();
    /// The proxy URL the core should use, or None when the tunnel is not installed.
    static PROXY_URL: Mutex<Option<String>> = Mutex::new(None);
    static APPLIER: OnceLock<()> = OnceLock::new();
    /// Serializes start/stop/install/remove.
    static OP: Mutex<()> = Mutex::new(());

    /// Every proxy URL this module writes starts with this; anything else in
    /// `proxy_url` is the user's own proxy and is left alone.
    const OURS: &str = "socks5://velta-tunnel:";

    fn lib() -> Result<&'static Lib, String> {
        LIB.get_or_init(|| unsafe {
            let l = libloading::Library::new("libsoartunnel.so")
                .map_err(|e| format!("DNS tunnel library not available: {e}"))?;
            macro_rules! sym {
                ($name:literal, $t:ty) => {
                    *l.get::<$t>($name)
                        .map_err(|e| format!("{}: {e}", String::from_utf8_lossy($name)))?
                };
            }
            let parse = sym!(b"VeltaTunnelParseLink\0", StrFn);
            let start = sym!(b"VeltaTunnelStart\0", StrFn);
            let stop = sym!(b"VeltaTunnelStop\0", VoidFn);
            let status = sym!(b"VeltaTunnelStatus\0", StatusFn);
            let set_mode = sym!(b"VeltaTunnelSetMode\0", StrFn);
            let net_changed = sym!(b"VeltaTunnelNetworkChanged\0", VoidFn);
            let free = sym!(b"VeltaTunnelFree\0", FreeFn);
            Ok(Lib { _lib: l, parse, start, stop, status, set_mode, net_changed, free })
        })
        .as_ref()
        .map_err(|e| e.clone())
    }

    /// Copies and frees a JSON string returned by the library; {"error": …} becomes Err.
    fn take(lib: &Lib, p: *mut c_char) -> Result<Value, String> {
        if p.is_null() {
            return Err("DNS tunnel library returned nothing".into());
        }
        let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        unsafe { (lib.free)(p) };
        let v: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        if let Some(e) = v.get("error").and_then(Value::as_str) {
            return Err(e.to_string());
        }
        Ok(v)
    }

    fn call(f: impl Fn(&Lib) -> StrFn, arg: &str) -> Result<Value, String> {
        let lib = lib()?;
        let c = CString::new(arg).map_err(|e| e.to_string())?;
        take(lib, unsafe { f(lib)(c.as_ptr()) })
    }

    fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
        Some(app.path().app_local_data_dir().ok()?.join("tunnel.json"))
    }

    fn load_config(app: &tauri::AppHandle) -> Option<Value> {
        let s = std::fs::read_to_string(config_path(app)?).ok()?;
        serde_json::from_str(&s).ok()
    }

    fn save_config(app: &tauri::AppHandle, cfg: &Value) -> Result<(), String> {
        let path = config_path(app).ok_or("no app data dir")?;
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&path, serde_json::to_string(cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }

    /// Starts the library from a stored config. Reuses the saved port so the
    /// accounts' proxy_url stays valid across restarts; falls back to any port.
    fn start(app: &tauri::AppHandle, mut cfg: Value) -> Result<(), String> {
        let res = call(|l| l.start, &cfg.to_string()).or_else(|e| {
            if cfg["listen"].as_str() == Some("127.0.0.1:0") {
                return Err(e);
            }
            crate::log(&format!("dns tunnel: saved port unavailable ({e}); picking a new one"));
            cfg["listen"] = Value::from("127.0.0.1:0");
            call(|l| l.start, &cfg.to_string())
        })?;
        let addr = res["addr"].as_str().ok_or("no listen address")?.to_string();
        cfg["listen"] = Value::from(addr.clone());
        save_config(app, &cfg)?;
        let user = cfg["user"].as_str().unwrap_or_default();
        let pass = cfg["pass"].as_str().unwrap_or_default();
        *PROXY_URL.lock().unwrap() = Some(format!("socks5://{user}:{pass}@{addr}"));
        crate::log(&format!("dns tunnel: listening on {addr}, mode {}", cfg["mode"].as_str().unwrap_or("auto")));
        start_applier();
        Ok(())
    }

    /// Keeps every profile's proxy_url in line with the tunnel: on install,
    /// on removal, and every minute so profiles added later pick it up.
    fn start_applier() {
        APPLIER.get_or_init(|| {
            tauri::async_runtime::spawn(async {
                loop {
                    apply_proxy().await;
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                }
            });
        });
    }

    pub(super) async fn apply_proxy() {
        let accounts = crate::ANDROID_ACCOUNTS.lock().unwrap().clone();
        let Some(accounts) = accounts else { return };
        let desired = PROXY_URL.lock().unwrap().clone();
        let ids = accounts.read().await.get_all();
        for id in ids {
            let Some(ctx) = accounts.read().await.get_account(id) else { continue };
            let cur = ctx.get_config(Config::ProxyUrl).await.ok().flatten().unwrap_or_default();
            let enabled = ctx.get_config_bool(Config::ProxyEnabled).await.unwrap_or(false);
            let ours = cur.starts_with(OURS);
            let result = match &desired {
                // A proxy the user set up themselves wins over the tunnel.
                Some(_) if !cur.trim().is_empty() && !ours => Ok(()),
                Some(url) => {
                    let mut r = Ok(());
                    if &cur != url {
                        r = ctx.set_config(Config::ProxyUrl, Some(url.as_str())).await;
                    }
                    if r.is_ok() && !enabled {
                        r = ctx.set_config(Config::ProxyEnabled, Some("1")).await;
                    }
                    r
                }
                None if ours => {
                    let r = ctx.set_config(Config::ProxyUrl, None).await;
                    if r.is_ok() { ctx.set_config(Config::ProxyEnabled, Some("0")).await } else { r }
                }
                None => Ok(()),
            };
            if let Err(e) = result {
                crate::log(&format!("dns tunnel: proxy update for account {id} failed: {e}"));
            }
        }
    }

    /// Called once the core is up: restart the tunnel if one is installed.
    pub fn boot(app: &tauri::AppHandle) {
        let _g = OP.lock().unwrap();
        let Some(cfg) = load_config(app) else { return };
        if let Err(e) = start(app, cfg) {
            crate::log(&format!("dns tunnel: start failed: {e}"));
        }
    }

    pub fn preview(link: &str) -> Result<Value, String> {
        let cfg = call(|l| l.parse, link)?;
        Ok(serde_json::json!({
            "zone": cfg["zone"],
            "resolvers": cfg["resolvers"].as_array().map_or(0, |a| a.len()),
            "canaries": cfg["canaries"],
        }))
    }

    pub fn install(app: &tauri::AppHandle, link: &str) -> Result<(), String> {
        let _g = OP.lock().unwrap();
        let cfg = call(|l| l.parse, link)?;
        start(app, cfg)?;
        tauri::async_runtime::spawn(apply_proxy());
        Ok(())
    }

    pub fn remove(app: &tauri::AppHandle) -> Result<(), String> {
        let _g = OP.lock().unwrap();
        if let Ok(lib) = lib() {
            unsafe { (lib.stop)() };
        }
        *PROXY_URL.lock().unwrap() = None;
        if let Some(path) = config_path(app) {
            let _ = std::fs::remove_file(path);
        }
        crate::log("dns tunnel: removed");
        tauri::async_runtime::spawn(apply_proxy());
        Ok(())
    }

    pub fn status(app: &tauri::AppHandle, events: i32) -> Value {
        let installed = load_config(app).is_some();
        let mut v = match lib() {
            Ok(lib) => take(lib, unsafe { (lib.status)(events) }).unwrap_or_else(|e| serde_json::json!({"error": e})),
            Err(e) => serde_json::json!({"available": false, "error": e}),
        };
        v["installed"] = Value::from(installed);
        if v.get("available").is_none() {
            v["available"] = Value::from(true);
        }
        v
    }

    pub fn set_mode(app: &tauri::AppHandle, mode: &str) -> Result<(), String> {
        let _g = OP.lock().unwrap();
        call(|l| l.set_mode, mode)?;
        if let Some(mut cfg) = load_config(app) {
            cfg["mode"] = Value::from(mode);
            save_config(app, &cfg)?;
        }
        Ok(())
    }

    pub fn network_changed() {
        if let Ok(lib) = lib() {
            unsafe { (lib.net_changed)() };
        }
    }
}

#[cfg(target_os = "android")]
pub use imp::boot;

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tunnel_preview(link: String) -> Result<Value, String> {
    imp::preview(&link)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tunnel_install(app: tauri::AppHandle, link: String) -> Result<(), String> {
    imp::install(&app, &link)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tunnel_remove(app: tauri::AppHandle) -> Result<(), String> {
    imp::remove(&app)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tunnel_status(app: tauri::AppHandle, events: Option<i32>) -> Value {
    imp::status(&app, events.unwrap_or(0))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tunnel_set_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    imp::set_mode(&app, &mode)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tunnel_network_changed() {
    imp::network_changed()
}

// Desktop: the tunnel targets mobile allowlists only; report it unavailable.
#[cfg(not(target_os = "android"))]
const UNAVAILABLE: &str = "The DNS tunnel is only available in the Android app";

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tunnel_preview(link: String) -> Result<Value, String> {
    let _ = link;
    Err(UNAVAILABLE.into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tunnel_install(link: String) -> Result<(), String> {
    let _ = link;
    Err(UNAVAILABLE.into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tunnel_remove() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tunnel_status(events: Option<i32>) -> Value {
    let _ = events;
    serde_json::json!({"available": false, "installed": false, "error": UNAVAILABLE})
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tunnel_set_mode(mode: String) -> Result<(), String> {
    let _ = mode;
    Err(UNAVAILABLE.into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tunnel_network_changed() {}
