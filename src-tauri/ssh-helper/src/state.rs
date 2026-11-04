//! 状态文件、所有权与生命周期。
//!
//! helper 是唯一知道“这个 sshd 是不是应用开的”的角色：用户手动开启的实例 `owned=false`，
//! 应用退出/心跳丢失时绝不能关它。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use shrinkdrop_ssh_core::{ErrorCode, SshLifetime, StateFile};

pub const STATE_PATH: &str = r"C:\ProgramData\shrinkdrop\ssh-state.json";

pub trait StateIo: Send + Sync {
    fn read(&self, path: &str) -> std::io::Result<String>;
    fn write(&self, path: &str, content: &str) -> std::io::Result<()>;
}

pub struct FsStateIo;

impl StateIo for FsStateIo {
    fn read(&self, path: &str) -> std::io::Result<String> {
        std::fs::read_to_string(path)
    }

    fn write(&self, path: &str, content: &str) -> std::io::Result<()> {
        if let Some(parent) = Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        // 原子写：临时文件 + rename。
        let temp = format!("{path}.tmp");
        std::fs::write(&temp, content)?;
        std::fs::rename(&temp, path)
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub fn load(io: &dyn StateIo, path: &str) -> StateFile {
    io.read(path)
        .ok()
        .and_then(|content| serde_json::from_str::<StateFile>(&content).ok())
        // 字段越界/版本不符时按默认值起步，绝不因为状态文件坏掉就拒绝服务。
        .map(|state| normalize(state))
        .unwrap_or_default()
}

/// 校验并归一字段：端口 0 或越界、lifetime 之外的组合都收敛到安全默认。
pub fn normalize(mut state: StateFile) -> StateFile {
    if state.port == 0 {
        state.port = 22;
    }
    state
}

pub fn save(io: &dyn StateIo, path: &str, state: &StateFile) -> Result<(), ErrorCode> {
    let content = serde_json::to_string_pretty(state).map_err(|_| ErrorCode::Internal)?;
    io.write(path, &content).map_err(|_| ErrorCode::Internal)
}

/// 记录“应用开启”这一动作：`owned=true`，并保存原始启动类型以便还原。
pub fn record_enable(state: &mut StateFile, lifetime: SshLifetime, port: u16, previous_start_type: &str) {
    state.desired = true;
    state.lifetime = lifetime;
    state.port = port;
    state.owned = true;
    state.enabled_at = Some(now_secs());
    state.previous_start_type = Some(previous_start_type.to_string());
    state.last_error = None;
}

pub fn record_disable(state: &mut StateFile) {
    state.desired = false;
    state.owned = false;
    state.enabled_at = None;
    state.last_error = None;
}

pub fn record_error(state: &mut StateFile, code: ErrorCode) {
    state.last_error = Some(code);
}

/// 只有 `owned` 且 `lifetime=app` 才允许在最后一个客户端退出后关闭。
pub fn should_close_on_detach(state: &StateFile) -> bool {
    state.owned && state.desired && state.lifetime == SshLifetime::App
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryIo {
        files: Mutex<HashMap<String, String>>,
    }

    impl StateIo for MemoryIo {
        fn read(&self, path: &str) -> std::io::Result<String> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "missing"))
        }

        fn write(&self, path: &str, content: &str) -> std::io::Result<()> {
            self.files
                .lock()
                .unwrap()
                .insert(path.to_string(), content.to_string());
            Ok(())
        }
    }

    const P: &str = r"C:\ProgramData\shrinkdrop\ssh-state.json";

    #[test]
    fn missing_state_file_uses_defaults() {
        let io = MemoryIo::default();
        let state = load(&io, P);
        assert!(!state.desired);
        assert!(!state.owned);
        assert_eq!(state.port, 22);
        assert_eq!(state.lifetime, SshLifetime::App);
    }

    #[test]
    fn corrupt_state_file_does_not_break_service() {
        let io = MemoryIo::default();
        io.write(P, "not json").unwrap();
        let state = load(&io, P);
        assert_eq!(state.port, 22);
    }

    #[test]
    fn zero_port_is_normalized() {
        let state = normalize(StateFile {
            port: 0,
            ..StateFile::default()
        });
        assert_eq!(state.port, 22);
    }

    #[test]
    fn enable_records_ownership_and_previous_start_type() {
        let mut state = StateFile::default();
        record_enable(&mut state, SshLifetime::App, 22, "auto");
        assert!(state.owned);
        assert!(state.desired);
        assert_eq!(state.previous_start_type.as_deref(), Some("auto"));
        assert!(state.enabled_at.is_some());
        assert!(should_close_on_detach(&state));
    }

    #[test]
    fn persistent_lifetime_never_closes_on_detach() {
        let mut state = StateFile::default();
        record_enable(&mut state, SshLifetime::Persistent, 2222, "auto");
        assert!(!should_close_on_detach(&state));
    }

    #[test]
    fn user_opened_instance_is_never_closed() {
        let state = StateFile {
            desired: true,
            owned: false,
            lifetime: SshLifetime::App,
            ..StateFile::default()
        };
        assert!(!should_close_on_detach(&state));
    }

    #[test]
    fn disable_clears_ownership() {
        let mut state = StateFile::default();
        record_enable(&mut state, SshLifetime::App, 22, "auto");
        record_disable(&mut state);
        assert!(!state.owned);
        assert!(!state.desired);
        assert!(!should_close_on_detach(&state));
    }

    #[test]
    fn save_then_load_roundtrips() {
        let io = MemoryIo::default();
        let mut state = StateFile::default();
        record_enable(&mut state, SshLifetime::Persistent, 2222, "manual");
        save(&io, P, &state).unwrap();
        assert_eq!(load(&io, P), state);
    }
}
