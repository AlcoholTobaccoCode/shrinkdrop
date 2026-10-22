//! 应用设置：持久化、校验与分享服务联动。

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::share::auth::{self, Account, Permissions, Protection};
use crate::share::{ShareManager, ShareOptions};

const SETTINGS_FILE: &str = "settings.json";
const MAX_CONCURRENCY: u8 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StartFace {
    Last,
    Compress,
    Share,
}

impl Default for StartFace {
    fn default() -> Self {
        Self::Last
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Face {
    Compress,
    Share,
}

impl Default for Face {
    fn default() -> Self {
        Self::Compress
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisitorLang {
    #[default]
    Auto,
    Zh,
    En,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct General {
    pub start_face: StartFace,
    pub last_face: Face,
    pub visitor_lang: VisitorLang,
}

impl Default for General {
    fn default() -> Self {
        Self {
            start_face: StartFace::Last,
            last_face: Face::Compress,
            visitor_lang: VisitorLang::Auto,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CompressionSettings {
    pub auto_compress: bool,
    pub concurrency: u8,
    pub save_dir: Option<String>,
}

impl Default for CompressionSettings {
    fn default() -> Self {
        Self {
            auto_compress: false,
            concurrency: MAX_CONCURRENCY,
            save_dir: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShareSettings {
    /// 0 表示自动：优先 5421，被占用时退回随机端口。
    pub port: u16,
    pub upload_dir: Option<String>,
    pub protection: Protection,
    pub pin_hash: Option<String>,
    pub allow_upload: bool,
    pub allow_text: bool,
    pub accounts: Vec<Account>,
}

impl Default for ShareSettings {
    fn default() -> Self {
        Self {
            port: 5421,
            upload_dir: None,
            protection: Protection::Link,
            pin_hash: None,
            allow_upload: false,
            allow_text: false,
            accounts: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub general: General,
    pub compression: CompressionSettings,
    pub share: ShareSettings,
}

pub struct SettingsState {
    inner: RwLock<Settings>,
}

impl Default for SettingsState {
    fn default() -> Self {
        Self {
            inner: RwLock::new(Settings::default()),
        }
    }
}

impl SettingsState {
    pub fn get(&self) -> Settings {
        self.inner
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn replace(&self, settings: Settings) {
        if let Ok(mut guard) = self.inner.write() {
            *guard = settings;
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    id: String,
    username: String,
    permissions: Permissions,
    enabled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareView {
    port: u16,
    upload_dir: Option<String>,
    protection: Protection,
    pin_set: bool,
    allow_upload: bool,
    allow_text: bool,
    accounts: Vec<AccountView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    general: General,
    compression: CompressionSettings,
    share: ShareView,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsMutation {
    settings: SettingsView,
    share_restarted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareUpdate {
    port: u16,
    upload_dir: Option<String>,
    protection: Protection,
    allow_upload: bool,
    allow_text: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    general: General,
    compression: CompressionSettings,
    share: ShareUpdate,
}

pub fn view(settings: &Settings) -> SettingsView {
    SettingsView {
        general: settings.general.clone(),
        compression: settings.compression.clone(),
        share: ShareView {
            port: settings.share.port,
            upload_dir: settings.share.upload_dir.clone(),
            protection: settings.share.protection,
            pin_set: settings.share.pin_hash.is_some(),
            allow_upload: settings.share.allow_upload,
            allow_text: settings.share.allow_text,
            accounts: settings
                .share
                .accounts
                .iter()
                .map(|account| AccountView {
                    id: account.id.clone(),
                    username: account.username.clone(),
                    permissions: account.permissions.clone(),
                    enabled: account.enabled,
                })
                .collect(),
        },
    }
}

pub fn upload_dir(settings: &ShareSettings) -> PathBuf {
    settings
        .upload_dir
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(default_upload_dir)
}

fn default_upload_dir() -> PathBuf {
    let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"));
    home.map(PathBuf::from)
        .map(|home| home.join("Downloads").join("TinyPNG Share"))
        .unwrap_or_else(|| env::temp_dir().join("TinyPNG Share"))
}

pub fn share_options(settings: &Settings) -> ShareOptions {
    ShareOptions {
        port: settings.share.port,
        protection: settings.share.protection,
        pin_hash: settings.share.pin_hash.clone(),
        allow_upload: settings.share.allow_upload,
        allow_text: settings.share.allow_text,
        accounts: settings.share.accounts.clone(),
        upload_dir: upload_dir(&settings.share),
        visitor_lang: settings.general.visitor_lang,
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE))
        .map_err(|_| "无法定位设置目录".to_string())
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn persist(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "无法创建设置目录".to_string())?;
    }
    let temp = path.with_extension("json.tmp");
    let content = serde_json::to_vec_pretty(settings).map_err(|_| "无法序列化设置".to_string())?;
    fs::write(&temp, content).map_err(|_| "无法写入设置".to_string())?;
    fs::rename(&temp, &path).map_err(|_| "无法保存设置".to_string())
}

fn validate(settings: &Settings) -> Result<(), String> {
    if !(1..=MAX_CONCURRENCY).contains(&settings.compression.concurrency) {
        return Err(format!("并发数需要在 1 到 {MAX_CONCURRENCY} 之间"));
    }
    if settings.share.port != 0 && settings.share.port < 1024 {
        return Err("端口需要大于等于 1024，或填 0 使用自动端口".to_string());
    }
    Ok(())
}

async fn restart_if_running(app: &AppHandle, manager: &ShareManager, settings: &Settings) -> bool {
    if !manager.status().running {
        return false;
    }
    match manager.restart(share_options(settings)).await {
        Ok(status) => {
            let _ = app.emit("share-status", status);
            true
        }
        Err(_) => false,
    }
}

fn mutation(settings: &Settings, restarted: bool) -> SettingsMutation {
    SettingsMutation {
        settings: view(settings),
        share_restarted: restarted,
    }
}

async fn commit(
    app: &AppHandle,
    state: &SettingsState,
    manager: &ShareManager,
    settings: Settings,
    restart: bool,
) -> Result<SettingsMutation, String> {
    validate(&settings)?;
    state.replace(settings.clone());
    persist(app, &settings)?;
    let restarted = if restart {
        restart_if_running(app, manager, &settings).await
    } else {
        false
    };
    let _ = app.emit("settings-changed", view(&settings));
    Ok(mutation(&settings, restarted))
}

#[tauri::command]
pub fn settings_get(state: State<'_, SettingsState>) -> SettingsView {
    view(&state.get())
}

#[tauri::command]
pub async fn settings_update(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, ShareManager>,
    update: SettingsUpdate,
) -> Result<SettingsMutation, String> {
    let current = state.get();
    let mut settings = current.clone();
    settings.general = update.general;
    settings.compression = update.compression;
    settings.share.port = update.share.port;
    settings.share.upload_dir = update
        .share
        .upload_dir
        .filter(|path| !path.trim().is_empty());
    settings.share.protection = update.share.protection;
    settings.share.allow_upload = update.share.allow_upload;
    settings.share.allow_text = update.share.allow_text;
    let restart = current.share.port != settings.share.port
        || current.share.protection != settings.share.protection
        || current.share.allow_upload != settings.share.allow_upload
        || current.share.allow_text != settings.share.allow_text
        || current.share.upload_dir != settings.share.upload_dir
        || current.general.visitor_lang != settings.general.visitor_lang;
    commit(&app, &state, &manager, settings, restart).await
}

#[tauri::command]
pub fn settings_touch_face(
    app: AppHandle,
    state: State<'_, SettingsState>,
    face: Face,
) -> Result<(), String> {
    let mut settings = state.get();
    settings.general.last_face = face;
    state.replace(settings.clone());
    persist(&app, &settings)
}

#[tauri::command]
pub async fn settings_pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|folder| folder.into_path().ok())
            .map(|path| path.display().to_string())
    })
    .await
    .map_err(|_| "选择文件夹失败，请重试".to_string())
}

#[tauri::command]
pub async fn share_set_pin(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, ShareManager>,
    pin: Option<String>,
) -> Result<SettingsMutation, String> {
    let mut settings = state.get();
    match pin {
        Some(pin) => {
            let valid = pin.len() == 6 && pin.chars().all(|value| value.is_ascii_digit());
            if !valid {
                return Err("PIN 需要是 6 位数字".to_string());
            }
            settings.share.pin_hash = Some(auth::hash_secret(&pin)?);
        }
        None => settings.share.pin_hash = None,
    }
    commit(&app, &state, &manager, settings, true).await
}

#[tauri::command]
pub async fn share_add_account(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, ShareManager>,
    username: String,
    password: String,
    permissions: Permissions,
) -> Result<SettingsMutation, String> {
    let username = username.trim().to_string();
    if username.is_empty() || username.chars().count() > 32 {
        return Err("用户名需要 1 到 32 个字符".to_string());
    }
    if password.chars().count() < 4 {
        return Err("密码至少 4 个字符".to_string());
    }
    let mut settings = state.get();
    if settings
        .share
        .accounts
        .iter()
        .any(|account| account.username == username)
    {
        return Err("用户名已存在".to_string());
    }
    settings.share.accounts.push(Account {
        id: auth::new_account_id(),
        username,
        password_hash: auth::hash_secret(&password)?,
        permissions,
        enabled: true,
    });
    commit(&app, &state, &manager, settings, true).await
}

#[tauri::command]
pub async fn share_update_account(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, ShareManager>,
    id: String,
    enabled: Option<bool>,
    permissions: Option<Permissions>,
    password: Option<String>,
) -> Result<SettingsMutation, String> {
    let mut settings = state.get();
    let Some(account) = settings
        .share
        .accounts
        .iter_mut()
        .find(|account| account.id == id)
    else {
        return Err("账号不存在".to_string());
    };
    if let Some(enabled) = enabled {
        account.enabled = enabled;
    }
    if let Some(permissions) = permissions {
        account.permissions = permissions;
    }
    if let Some(password) = password {
        if password.chars().count() < 4 {
            return Err("密码至少 4 个字符".to_string());
        }
        account.password_hash = auth::hash_secret(&password)?;
    }
    commit(&app, &state, &manager, settings, true).await
}

#[tauri::command]
pub async fn share_delete_account(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, ShareManager>,
    id: String,
) -> Result<SettingsMutation, String> {
    let mut settings = state.get();
    settings.share.accounts.retain(|account| account.id != id);
    commit(&app, &state, &manager, settings, true).await
}
