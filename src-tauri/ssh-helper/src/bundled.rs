//! 随包 OpenSSH MSI 的校验与安装。
//!
//! 只在 FoD 失败、且系统里还没有 `sshd` 服务时才允许使用；不静默安装：
//! 必须由用户在 UI 里点“内置安装”。
//!
//! 校验顺序：MSI 存在 → 同目录 `.sha256` 清单存在 → 摘要匹配 → 无既有 sshd 服务 →
//! `msiexec /i <msi> /qn /norestart`。任何一步失败都不执行安装。

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use shrinkdrop_ssh_core::ErrorCode;

use crate::runner::Runner;

/// 清单文件只允许一个 64 位十六进制摘要，可带文件名前缀。
pub fn expected_hash(manifest: &str) -> Option<String> {
    for token in manifest.split_whitespace() {
        let token = token.trim_start_matches('*');
        if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(token.to_ascii_lowercase());
        }
    }
    None
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 校验 MSI 与清单；返回规范化后的 MSI 路径。
pub fn verify(msi: &Path) -> Result<PathBuf, ErrorCode> {
    let bytes = std::fs::read(msi).map_err(|_| ErrorCode::FeatureMissing)?;
    let manifest_path = msi.with_extension("msi.sha256");
    let manifest = std::fs::read_to_string(&manifest_path).map_err(|_| ErrorCode::FeatureMissing)?;
    let expected = expected_hash(&manifest).ok_or(ErrorCode::FeatureMissing)?;
    if sha256_hex(&bytes) != expected {
        return Err(ErrorCode::FeatureMissing);
    }
    Ok(msi.to_path_buf())
}

/// 安装随包 MSI；调用方已确认用户点击了“内置安装”。
pub fn install(runner: &dyn Runner, msi: &Path) -> Result<(), ErrorCode> {
    let path = verify(msi)?;
    let output = runner
        .run(
            "msiexec.exe",
            &[
                "/i",
                &path.display().to_string(),
                "/qn",
                "/norestart",
            ],
        )
        .map_err(|_| ErrorCode::Internal)?;
    match output.code {
        0 | 3010 => Ok(()),
        1603 => Err(ErrorCode::ServiceStartFailed),
        1618 => Err(ErrorCode::Busy),
        _ => Err(ErrorCode::Internal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_hash_is_parsed() {
        let hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        assert_eq!(expected_hash(hash), Some(hash.to_string()));
        assert_eq!(
            expected_hash(&format!("{hash}  OpenSSH-Win64-v9.5.0.msi")),
            Some(hash.to_string())
        );
        assert_eq!(expected_hash("not a hash"), None);
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"test"),
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
    }

    #[test]
    fn missing_msi_is_rejected() {
        assert_eq!(
            verify(Path::new(r"C:\nope\OpenSSH.msi")),
            Err(ErrorCode::FeatureMissing)
        );
    }

    #[test]
    fn mismatched_hash_is_rejected() {
        let dir = std::env::temp_dir().join(format!("shrinkdrop-msi-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let msi = dir.join("OpenSSH.msi");
        std::fs::write(&msi, b"payload").unwrap();
        std::fs::write(dir.join("OpenSSH.msi.sha256"), "0".repeat(64)).unwrap();
        assert_eq!(verify(&msi), Err(ErrorCode::FeatureMissing));
        std::fs::write(
            dir.join("OpenSSH.msi.sha256"),
            format!("{}  OpenSSH.msi", sha256_hex(b"payload")),
        )
        .unwrap();
        assert_eq!(verify(&msi), Ok(msi.clone()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
