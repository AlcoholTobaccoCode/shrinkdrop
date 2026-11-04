//! helper 尚未随包提供时的后端。
//!
//! 只返回 `helper_unavailable`，绝不静默改动系统：没有 helper 就没有可审计的
//! 特权控制面，UI 必须显式告诉用户“需要辅助服务”，而不是假装开关可用。

use shrinkdrop_ssh_core::SshLifetime;

use super::{HelperInfo, SshBackend, SshError, HelperStatus};
use shrinkdrop_ssh_core::ErrorCode;

pub struct UnavailableBackend;

fn unavailable() -> SshError {
    SshError::with_detail(
        ErrorCode::HelperUnavailable,
        "helper 未随此构建提供",
    )
}

impl SshBackend for UnavailableBackend {
    fn helper_info(&self) -> HelperInfo {
        HelperInfo::default()
    }

    fn status(&self) -> Result<HelperStatus, SshError> {
        Err(unavailable())
    }

    fn enable(&self, _lifetime: SshLifetime, _port: u16) -> Result<HelperStatus, SshError> {
        Err(unavailable())
    }

    fn disable(&self) -> Result<HelperStatus, SshError> {
        Err(unavailable())
    }

    fn set_lifetime(&self, _lifetime: SshLifetime) -> Result<HelperStatus, SshError> {
        Err(unavailable())
    }

    fn set_port(&self, _port: u16) -> Result<HelperStatus, SshError> {
        Err(unavailable())
    }

    fn attach(&self) -> Result<(), SshError> {
        Err(unavailable())
    }

    fn detach(&self) -> Result<(), SshError> {
        Ok(())
    }

    fn install_helper(&self) -> Result<(), SshError> {
        Err(unavailable())
    }

    fn uninstall_helper(&self) -> Result<(), SshError> {
        Ok(())
    }
}
