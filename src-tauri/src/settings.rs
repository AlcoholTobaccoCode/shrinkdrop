//! 应用设置：持久化、校验与分享服务联动。

use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

use crate::share::auth::{self, Account, Permissions, Protection};
use crate::share::{GroupOptions, ShareManager, ShareOptions};

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
pub enum Language {
    #[default]
    Auto,
    Zh,
    En,
}

impl Language {
    /// 访客页最终展示的语言；Auto 跟随系统，取不到时回退中文。
    pub fn effective(self) -> &'static str {
        match self {
            Language::Zh => "zh",
            Language::En => "en",
            Language::Auto => match sys_locale::get_locale() {
                Some(locale) if locale.to_lowercase().starts_with("zh") => "zh",
                Some(_) => "en",
                None => "zh",
            },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct General {
    pub start_face: StartFace,
    pub last_face: Face,
    #[serde(default, alias = "visitorLang")]
    pub language: Language,
    /// macOS 防休眠档位；见 power::KeepAwake。
    #[serde(default)]
    pub keep_awake: crate::power::KeepAwake,
}

impl Default for General {
    fn default() -> Self {
        Self {
            start_face: StartFace::Last,
            last_face: Face::Compress,
            language: Language::Auto,
            keep_awake: crate::power::KeepAwake::Off,
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
    #[serde(default)]
    pub groups: Vec<GroupSettings>,
    pub protection: Protection,
    pub public: bool,
    pub pin_hash: Option<String>,
    pub allow_upload: bool,
    pub allow_text: bool,
    #[serde(default)]
    pub auto_save_uploads: bool,
    pub accounts: Vec<Account>,
}

impl Default for ShareSettings {
    fn default() -> Self {
        Self {
            port: 5421,
            upload_dir: None,
            groups: Vec::new(),
            protection: Protection::Link,
            public: false,
            pin_hash: None,
            allow_upload: false,
            allow_text: false,
            auto_save_uploads: false,
            accounts: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GroupSettings {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub public: bool,
    pub protection: Protection,
    pub pin_hash: Option<String>,
    pub allow_upload: bool,
    pub allow_text: bool,
}

impl Default for GroupSettings {
    fn default() -> Self {
        Self {
            id: random_slug(),
            name: "分组".to_string(),
            slug: random_slug(),
            public: false,
            protection: Protection::Link,
            pin_hash: None,
            allow_upload: false,
            allow_text: false,
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
    password: String,
    permissions: Permissions,
    enabled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareView {
    port: u16,
    upload_dir: Option<String>,
    protection: Protection,
    public: bool,
    pin_set: bool,
    allow_upload: bool,
    allow_text: bool,
    auto_save_uploads: bool,
    accounts: Vec<AccountView>,
    groups: Vec<GroupView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    id: String,
    name: String,
    slug: String,
    public: bool,
    protection: Protection,
    pin_set: bool,
    allow_upload: bool,
    allow_text: bool,
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
    public: bool,
    allow_upload: bool,
    allow_text: bool,
    auto_save_uploads: bool,
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
            public: settings.share.public,
            pin_set: settings.share.pin_hash.is_some(),
            allow_upload: settings.share.allow_upload,
            allow_text: settings.share.allow_text,
            auto_save_uploads: settings.share.auto_save_uploads,
            accounts: settings.share.accounts.iter().map(account_view).collect(),
            groups: settings
                .share
                .groups
                .iter()
                .map(|group| GroupView {
                    id: group.id.clone(),
                    name: group.name.clone(),
                    slug: group.slug.clone(),
                    public: group.public,
                    protection: group.protection,
                    pin_set: group.pin_hash.is_some(),
                    allow_upload: group.allow_upload,
                    allow_text: group.allow_text,
                })
                .collect(),
        },
    }
}

fn account_view(account: &Account) -> AccountView {
    AccountView {
        id: account.id.clone(),
        username: account.username.clone(),
        password: account.password.clone(),
        permissions: account.permissions.clone(),
        enabled: account.enabled,
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
        .map(|home| home.join("Downloads").join("shrinkdrop Share"))
        .unwrap_or_else(|| env::temp_dir().join("shrinkdrop Share"))
}

pub fn share_options(settings: &Settings) -> ShareOptions {
    let root = upload_dir(&settings.share);
    let mut groups = vec![GroupOptions {
        id: "default".to_string(),
        name: "默认分组".to_string(),
        slug: String::new(),
        upload_dir: root.clone(),
        public: settings.share.public,
        protection: settings.share.protection,
        pin_hash: settings.share.pin_hash.clone(),
        allow_upload: settings.share.allow_upload,
        allow_text: settings.share.allow_text,
    }];
    for group in &settings.share.groups {
        groups.push(GroupOptions {
            id: group.id.clone(),
            name: group.name.clone(),
            slug: group.slug.clone(),
            upload_dir: root.join("groups").join(&group.slug),
            public: group.public,
            protection: group.protection,
            pin_hash: group.pin_hash.clone(),
            allow_upload: group.allow_upload,
            allow_text: group.allow_text,
        });
    }
    ShareOptions {
        port: settings.share.port,
        protection: settings.share.protection,
        public: settings.share.public,
        pin_hash: settings.share.pin_hash.clone(),
        allow_upload: settings.share.allow_upload,
        allow_text: settings.share.allow_text,
        auto_save_uploads: settings.share.auto_save_uploads,
        accounts: settings.share.accounts.clone(),
        upload_dir: root,
        language: settings.general.language,
        groups,
    }
}

fn random_slug() -> String {
    let mut bytes = [0u8; 5];
    if getrandom::fill(&mut bytes).is_err() {
        return "group".to_string();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_slug(slug: &str) -> bool {
    (2..=32).contains(&slug.len())
        && slug
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-')
        && slug != "default"
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE))
        .map_err(|_| "无法定位设置目录".to_string())
}

/// 防休眠状态目录：helper 的状态/PID/标记文件都放在这里。
pub fn keep_awake_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("shrinkdrop"))
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
    let mut slugs = HashSet::new();
    for group in &settings.share.groups {
        if !valid_slug(&group.slug) {
            return Err("分组路径只能使用 2~32 位小写字母、数字或短横线".to_string());
        }
        if !slugs.insert(group.slug.clone()) {
            return Err("分组路径不能重复".to_string());
        }
    }
    Ok(())
}

async fn restart_if_running(app: &AppHandle, manager: &ShareManager, settings: &Settings) -> bool {
    if !manager.status().running {
        return false;
    }
    match manager
        .restart(share_options(settings), Some(app.clone()))
        .await
    {
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
    let previous = state.get();
    state.replace(settings.clone());
    persist(app, &settings)?;
    // 第三档需要管理员授权：授权失败时回滚档位，避免界面显示"已开启"但系统仍在休眠。
    if let Err(error) = app
        .state::<crate::power::SleepInhibitor>()
        .apply(settings.general.keep_awake)
    {
        let mut rolled_back = settings.clone();
        rolled_back.general.keep_awake = previous.general.keep_awake;
        state.replace(rolled_back.clone());
        persist(app, &rolled_back)?;
        let _ = app.emit("settings-toast", error);
        return Err("防休眠设置未生效".to_string());
    }
    let restarted = if restart {
        restart_if_running(app, manager, &settings).await
    } else {
        false
    };
    manager.set_language(settings.general.language);
    if restarted {
        let _ = app.emit(
            "settings-toast",
            "分享已按新设置重启，旧链接已失效，请重新扫码。".to_string(),
        );
    }
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
    settings.share.public = update.share.public;
    settings.share.allow_upload = update.share.allow_upload;
    settings.share.allow_text = update.share.allow_text;
    settings.share.auto_save_uploads = update.share.auto_save_uploads;
    let restart = current.share.port != settings.share.port
        || current.share.protection != settings.share.protection
        || current.share.public != settings.share.public
        || current.share.allow_upload != settings.share.allow_upload
        || current.share.allow_text != settings.share.allow_text
        || current.share.auto_save_uploads != settings.share.auto_save_uploads
        || current.share.upload_dir != settings.share.upload_dir;
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
pub async fn share_group_add(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, ShareManager>,
    name: String,
    slug: Option<String>,
) -> Result<SettingsMutation, String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 32 {
        return Err("分组名称需要 1 到 32 个字符".to_string());
    }
    let mut settings = state.get();
    let mut slug = slug
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    if let Some(value) = slug.as_ref() {
        if !valid_slug(value) {
            return Err("分组路径只能使用 2~32 位小写字母、数字或短横线".to_string());
        }
        if settings
            .share
            .groups
            .iter()
            .any(|group| &group.slug == value)
        {
            return Err("分组路径已存在".to_string());
        }
    } else {
        for _ in 0..20 {
            let candidate = random_slug();
            if !settings
                .share
                .groups
                .iter()
                .any(|group| group.slug == candidate)
            {
                slug = Some(candidate);
                break;
            }
        }
    }
    let slug = slug.ok_or_else(|| "无法生成分组路径".to_string())?;
    settings.share.groups.push(GroupSettings {
        id: random_slug(),
        name,
        slug,
        public: false,
        protection: Protection::Link,
        pin_hash: None,
        allow_upload: false,
        allow_text: false,
    });
    commit(&app, &state, &manager, settings, true).await
}

#[tauri::command]
pub async fn share_group_update(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, ShareManager>,
    id: String,
    name: String,
    slug: String,
) -> Result<SettingsMutation, String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 32 {
        return Err("分组名称需要 1 到 32 个字符".to_string());
    }
    let slug = slug.trim().to_ascii_lowercase();
    if !valid_slug(&slug) {
        return Err("分组路径只能使用 2~32 位小写字母、数字或短横线".to_string());
    }
    let mut settings = state.get();
    if settings
        .share
        .groups
        .iter()
        .any(|group| group.slug == slug && group.id != id)
    {
        return Err("分组路径已存在".to_string());
    }
    let Some(group) = settings
        .share
        .groups
        .iter_mut()
        .find(|group| group.id == id)
    else {
        return Err("分组不存在".to_string());
    };
    group.name = name;
    group.slug = slug;
    commit(&app, &state, &manager, settings, true).await
}

#[tauri::command]
pub async fn share_group_delete(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, ShareManager>,
    id: String,
) -> Result<SettingsMutation, String> {
    let mut settings = state.get();
    let before = settings.share.groups.len();
    settings.share.groups.retain(|group| group.id != id);
    if settings.share.groups.len() == before {
        return Err("分组不存在".to_string());
    }
    commit(&app, &state, &manager, settings, true).await
}

#[tauri::command]
pub async fn share_group_access(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, ShareManager>,
    id: String,
    public: bool,
    protection: Protection,
    allow_upload: bool,
    allow_text: bool,
) -> Result<SettingsMutation, String> {
    let mut settings = state.get();
    let Some(group) = settings
        .share
        .groups
        .iter_mut()
        .find(|group| group.id == id)
    else {
        return Err("分组不存在".to_string());
    };
    group.public = public;
    group.protection = protection;
    group.allow_upload = allow_upload;
    group.allow_text = allow_text;
    commit(&app, &state, &manager, settings, true).await
}

#[tauri::command]
pub async fn share_group_set_pin(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, ShareManager>,
    id: String,
    pin: Option<String>,
) -> Result<SettingsMutation, String> {
    let mut settings = state.get();
    let Some(group) = settings
        .share
        .groups
        .iter_mut()
        .find(|group| group.id == id)
    else {
        return Err("分组不存在".to_string());
    };
    group.pin_hash = match pin {
        Some(pin) if !pin.is_empty() => Some(auth::hash_secret(pin.trim())?),
        _ => None,
    };
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
        password,
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
        account.password = password;
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

#[tauri::command]
pub fn settings_close(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.close().map_err(|_| "无法关闭设置窗口".to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn settings_open(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("设置 · shrinkdrop")
        .inner_size(760.0, 680.0)
        .center()
        .resizable(false)
        .maximizable(false)
        .build()
        .map(|_| ())
        .map_err(|_| "无法打开设置窗口".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_setting_migrates_visitor_lang_key() {
        let general: General = serde_json::from_str(r#"{"visitorLang":"en"}"#).unwrap();
        assert_eq!(general.language, Language::En);
        let general: General = serde_json::from_str(r#"{"language":"zh"}"#).unwrap();
        assert_eq!(general.language, Language::Zh);
    }

    #[test]
    fn explicit_language_codes_are_stable() {
        assert_eq!(Language::Zh.effective(), "zh");
        assert_eq!(Language::En.effective(), "en");
    }
}
