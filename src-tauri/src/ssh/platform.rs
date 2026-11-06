//! 平台能力门禁：只有满足最低系统版本的平台才允许渲染 SSH 开关。

use std::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Windows,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::MacOs
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else {
            Platform::Other
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Platform::MacOs => "macos",
            Platform::Windows => "windows",
            Platform::Other => "other",
        }
    }

    /// macOS 需要 13+ 才能用 SMAppService 注册 helper；Windows 需要 1809（build 17763）+。
    pub fn supported(self) -> bool {
        match self {
            Platform::MacOs => macos_version().is_some_and(|major| major >= 13),
            Platform::Windows => windows_build().is_some_and(|build| build >= 17763),
            Platform::Other => false,
        }
    }
}

/// 当前登录账户是否有管理员权限；非管理员只展示状态，不弹无意义的授权框。
pub fn is_admin() -> bool {
    if cfg!(target_os = "macos") {
        let output = Command::new("id").arg("-Gn").output();
        return output.is_ok_and(|output| {
            String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .any(|group| group == "admin")
        });
    }
    if cfg!(target_os = "windows") {
        let output = Command::new("whoami")
            .args(["/groups", "/fo", "csv", "/nh"])
            .output();
        return output.is_ok_and(|output| {
            parse_windows_admin(&String::from_utf8_lossy(&output.stdout))
        });
    }
    false
}

/// `whoami /groups` 的 CSV 里是否出现 Administrators（S-1-5-32-544）。
///
/// 只要出现就算管理员账户 —— UAC 关闭提权时该行会写成「仅用于拒绝的组 / Group used for
/// deny only」，但那仍然表示这个账户是管理员，只是当前进程没提权。真正的操作权限由
/// helper 与 UAC 决定，这里只回答“这个账户能不能安装/管理辅助服务”。
/// 反过来，用属性文本过滤会踩本地化：中文 Windows 不出现 "deny"，英文 Windows 出现，
/// 同一账户在两个系统上结论就不一样了。
pub fn parse_windows_admin(groups: &str) -> bool {
    groups
        .lines()
        .any(|line| line.to_lowercase().contains("s-1-5-32-544"))
}

fn macos_version() -> Option<u32> {
    let output = Command::new("sw_vers").arg("-productVersion").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout);
    parse_macos_major(&version)
}

/// `26.2` / `14.7.1` → 主版本号。
pub fn parse_macos_major(version: &str) -> Option<u32> {
    version
        .trim()
        .split('.')
        .next()
        .and_then(|major| major.trim().parse::<u32>().ok())
}

fn windows_build() -> Option<u32> {
    let output = Command::new("cmd").args(["/C", "ver"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_windows_build(&String::from_utf8_lossy(&output.stdout))
}

/// `Microsoft Windows [Version 10.0.22631.4317]` → 22631。
pub fn parse_windows_build(version: &str) -> Option<u32> {
    let inner = version.split('[').nth(1)?.trim_end_matches(']').trim();
    let mut parts = inner.split('.');
    parts.next()?;
    parts.next()?;
    parts.next()?.parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_major_is_parsed() {
        assert_eq!(parse_macos_major("26.2"), Some(26));
        assert_eq!(parse_macos_major("14.7.1\n"), Some(14));
        assert_eq!(parse_macos_major("bad"), None);
    }

    #[test]
    fn windows_build_is_parsed() {
        assert_eq!(
            parse_windows_build("Microsoft Windows [Version 10.0.22631.4317]\r\n"),
            Some(22631)
        );
        assert_eq!(parse_windows_build("unexpected"), None);
    }

    #[test]
    fn windows_admin_group_is_detected_from_whoami() {
        let elevated = r#""Administrators","S-1-5-32-544","Enabled group","Enabled",""
"Users","S-1-5-32-545","Mandatory group","Enabled",""
"#;
        // 未提权的管理员：Attributes 列是本地化文本，中英文都必须判成管理员。
        let filtered_zh = r#""Administrators","S-1-5-32-544","仅用于拒绝的组","已启用",""
"Users","S-1-5-32-545","强制组","已启用",""
"#;
        let filtered_en = r#""Administrators","S-1-5-32-544","Group used for deny only","Enabled",""
"Users","S-1-5-32-545","Mandatory group","Enabled",""
"#;
        let standard = r#""Users","S-1-5-32-545","Mandatory group","Enabled",""
"#;
        assert!(parse_windows_admin(elevated));
        assert!(parse_windows_admin(filtered_zh));
        assert!(parse_windows_admin(filtered_en));
        assert!(!parse_windows_admin(standard));
    }

    #[test]
    fn unsupported_platform_has_no_version_gate() {
        assert!(!Platform::Other.supported());
        assert_eq!(Platform::Other.as_str(), "other");
    }
}
