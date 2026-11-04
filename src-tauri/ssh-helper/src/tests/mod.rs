//! helper 状态机测试：所有权、生命周期、端口占用、失败回滚、引用计数。


use std::sync::Arc;

use shrinkdrop_ssh_core::{ErrorCode, OsState, SshLifetime};
use crate::helper::Helper;

use crate::testing::{Fake, Svc};

fn make_helper() -> (Arc<Fake>, Helper) {
    let fake = Arc::new(Fake::new());
    let helper = Helper::new(
        fake.clone(),
        fake.clone(),
        fake.clone(),
        "config",
        "state.json",
    );
    (fake, helper)
}

#[test]
fn status_reports_service_missing() {
    let (fake, helper) = make_helper();
    fake.lock().svc = None;
    let error = helper.status().unwrap_err();
    assert_eq!(error.code, ErrorCode::ServiceMissing);
}

#[test]
fn enable_installs_feature_when_sshd_is_absent() {
    let (fake, subject) = make_helper();
    fake.lock().svc = None;
    let status = subject.enable(SshLifetime::Persistent, 22).unwrap();
    assert!(status.os_enabled);
    assert!(status.owned);
    assert_eq!(status.os_state, Some(OsState::Enabled));
    assert!(fake.lock().feature);
    assert_eq!(fake.lock().start, "auto");
}

#[test]
fn enable_when_already_running_does_not_take_ownership() {
    let (fake, helper) = make_helper();
    fake.pre_enabled("auto");
    let status = helper.enable(SshLifetime::App, 22).unwrap();
    assert!(status.os_enabled);
    assert!(!status.owned, "用户手动开启的实例不属于应用");
    assert_eq!(fake.lock().start, "auto", "不应改写用户的启动类型");
}

#[test]
fn disable_only_stops_owned_instance() {
    let (fake, helper) = make_helper();
    fake.pre_enabled("auto");
    let status = helper.disable().unwrap();
    assert!(status.os_enabled, "手动开启的 SSH 不能被误关");
    assert!(!status.enabled);
    assert_eq!(fake.lock().start, "auto");
}

#[test]
fn owned_instance_is_stopped_and_start_type_restored() {
    let (fake, subject) = make_helper();
    // 用户原本把 sshd 设为 Disabled；应用开启后必须能还原成 Disabled。
    fake.lock().svc = Some(Svc::Stopped {
        start: "disabled".to_string(),
    });
    fake.lock().start = "disabled".to_string();
    subject.enable(SshLifetime::App, 22).unwrap();
    assert_eq!(fake.lock().start, "demand", "开启期间用按需启动");
    subject.disable().unwrap();
    assert_eq!(fake.lock().start, "disabled", "关闭后还原用户设置");
    assert!(matches!(fake.lock().svc, Some(Svc::Stopped { .. })));
}

#[test]
fn port_in_use_blocks_enable_without_touching_config() {
    let (fake, helper) = make_helper();
    fake.lock().svc = Some(Svc::Stopped {
        start: "demand".to_string(),
    });
    fake.occupy(2222, 999, "python.exe");
    let error = helper.enable(SshLifetime::Persistent, 2222).unwrap_err();
    assert_eq!(error.code, ErrorCode::PortInUse);
    assert_eq!(fake.lock().config, "Port 22\nPasswordAuthentication yes\n");
}

#[test]
fn custom_port_is_written_as_managed_block_and_old_port_commented() {
    let (fake, helper) = make_helper();
    helper.enable(SshLifetime::Persistent, 2222).unwrap();
    let config = fake.lock().config.clone();
    assert!(config.contains("Port 2222"));
    assert!(config.contains("# shrinkdrop: Port 22"));
}

#[test]
fn invalid_config_rolls_back_and_keeps_service_stopped() {
    let (fake, helper) = make_helper();
    fake.lock().svc = Some(Svc::Stopped {
        start: "demand".to_string(),
    });
    fake.lock().config_valid = false;
    let error = helper.enable(SshLifetime::Persistent, 2222).unwrap_err();
    assert_eq!(error.code, ErrorCode::ServiceStartFailed);
    assert_eq!(fake.lock().config, "Port 22\nPasswordAuthentication yes\n");
}

#[test]
fn failed_start_keeps_desired_state_off() {
    let (fake, helper) = make_helper();
    fake.lock().svc = Some(Svc::Stopped {
        start: "demand".to_string(),
    });
    fake.lock().fail_start = true;
    let error = helper.enable(SshLifetime::Persistent, 22).unwrap_err();
    assert_eq!(error.code, ErrorCode::ServiceStartFailed);
    let status = helper.status().unwrap();
    assert!(!status.enabled);
    assert!(!status.owned);
}

#[test]
fn detach_closes_owned_app_instance_on_last_client() {
    let (_, helper) = make_helper();
    helper.enable(SshLifetime::App, 22).unwrap();
    helper.attach().unwrap();
    helper.attach().unwrap();
    helper.detach().unwrap();
    let status = helper.status().unwrap();
    assert!(status.os_enabled, "还有客户端时不应关闭");
    helper.detach().unwrap();
    let status = helper.status().unwrap();
    assert!(!status.os_enabled, "最后一个客户端退出后应关闭");
    assert!(!status.owned);
}

#[test]
fn persistent_instance_survives_detach() {
    let (_, helper) = make_helper();
    helper.enable(SshLifetime::Persistent, 22).unwrap();
    helper.attach().unwrap();
    helper.detach().unwrap();
    let status = helper.status().unwrap();
    assert!(status.os_enabled);
    assert!(status.owned);
}

#[test]
fn heartbeat_loss_closes_only_owned_app_instances() {
    let (_, helper) = make_helper();
    helper.enable(SshLifetime::App, 22).unwrap();
    helper.heartbeat_lost().unwrap();
    assert!(!helper.status().unwrap().os_enabled);

    let (fake2, helper2) = make_helper();
    fake2.pre_enabled("auto");
    helper2.heartbeat_lost().unwrap();
    assert!(helper2.status().unwrap().os_enabled, "别人的实例不能关");
}

#[test]
fn set_lifetime_switches_start_type_when_owned() {
    let (fake, helper) = make_helper();
    helper.enable(SshLifetime::Persistent, 22).unwrap();
    helper.set_lifetime(SshLifetime::App).unwrap();
    assert_eq!(fake.lock().start, "demand");
    helper.set_lifetime(SshLifetime::Persistent).unwrap();
    assert_eq!(fake.lock().start, "auto");
}

#[test]
fn set_port_before_enable_only_persists_preference() {
    let (fake, helper) = make_helper();
    helper.set_port(2222).unwrap();
    let status = helper.status().unwrap();
    assert_eq!(status.port, 2222);
    assert_eq!(fake.lock().config, "Port 22\nPasswordAuthentication yes\n");
}

#[test]
fn set_port_when_enabled_restarts_and_replaces_rule() {
    let (fake, helper) = make_helper();
    helper.enable(SshLifetime::Persistent, 22).unwrap();
    helper.set_port(2222).unwrap();
    let state = fake.lock();
    assert!(state.rules.contains(&"shrinkdrop-ssh-2222".to_string()));
    assert!(!state.rules.contains(&"shrinkdrop-ssh-22".to_string()));
    assert!(state.config.contains("Port 2222"));
}

#[test]
fn occupied_port_on_change_is_rejected_and_keeps_old_port() {
    let (fake, helper) = make_helper();
    helper.enable(SshLifetime::Persistent, 22).unwrap();
    fake.occupy(2222, 999, "nginx.exe");
    let error = helper.set_port(2222).unwrap_err();
    assert_eq!(error.code, ErrorCode::PortInUse);
    assert_eq!(helper.status().unwrap().port, 22);
}

#[test]
fn unknown_owner_marks_state_unknown_instead_of_enabled() {
    let (fake, helper) = make_helper();
    fake.lock().svc = Some(Svc::Stopped {
        start: "demand".to_string(),
    });
    fake.occupy(22, 999, "nginx.exe");
    let status = helper.status().unwrap();
    assert_eq!(status.os_state, Some(OsState::Unknown));
    assert!(!status.listening, "别人的监听不能算作 sshd 在监听");
    assert_eq!(status.port_in_use.map(|owner| owner.port), Some(22));
}

#[test]
fn uninstall_restores_config_and_clears_state() {
    let (fake, helper) = make_helper();
    helper.enable(SshLifetime::App, 22).unwrap();
    helper.uninstall().unwrap();
    assert_eq!(fake.lock().config, "Port 22\nPasswordAuthentication yes\n");
    let status = helper.status();
    // 服务仍在（卸载 helper 不删系统 OpenSSH），但期望状态已清空。
    assert!(!status.unwrap().enabled);
}

#[test]
fn repeated_enable_is_idempotent() {
    let (fake, subject) = make_helper();
    subject.enable(SshLifetime::Persistent, 2222).unwrap();
    subject.enable(SshLifetime::Persistent, 2222).unwrap();
    assert_eq!(fake.lock().rules.len(), 1, "不应重复创建防火墙规则");
}

#[test]
fn enabling_on_the_default_port_leaves_sshd_config_untouched() {
    let (fake, subject) = make_helper();
    subject.enable(SshLifetime::Persistent, 22).unwrap();
    assert_eq!(
        fake.lock().config,
        "Port 22\nPasswordAuthentication yes\n",
        "端口没变就不该改用户的系统配置"
    );
    assert!(
        !fake.lock().files.contains_key("config.shrinkdrop-backup"),
        "端口没变就不该留下 sshd_config 备份"
    );
}

#[test]
fn enabling_on_a_port_the_config_already_listens_to_does_not_rewrite() {
    let (fake, subject) = make_helper();
    fake.lock().config = "Port 2222\nPasswordAuthentication yes\n".to_string();
    subject.enable(SshLifetime::Persistent, 2222).unwrap();
    assert_eq!(fake.lock().config, "Port 2222\nPasswordAuthentication yes\n");
}

#[test]
fn concurrent_enable_from_two_clients_does_not_double_start() {
    use std::sync::Arc;

    let (fake, subject) = make_helper();
    let subject = Arc::new(subject);
    let mut handles = Vec::new();
    for _ in 0..2 {
        let subject = subject.clone();
        handles.push(std::thread::spawn(move || {
            // 用非 22 端口：22 走系统既有规则，看不到“重复建规则”。
            subject.enable(SshLifetime::Persistent, 2222)
        }));
    }
    for handle in handles {
        handle.join().unwrap().unwrap();
    }
    let state = fake.lock();
    assert_eq!(state.rules.len(), 1, "并发开启不应重复建规则");
    assert!(matches!(state.svc, Some(Svc::Running { .. })));
}

#[test]
fn status_does_not_block_while_a_client_holds_an_attached_session() {
    let (_, subject) = make_helper();
    subject.enable(SshLifetime::App, 22).unwrap();
    // 长连接持有引用计数；状态查询必须仍能返回（helper 按连接并发处理）。
    subject.attach().unwrap();
    assert!(subject.status().unwrap().os_enabled);
    subject.detach().unwrap();
    assert!(!subject.status().unwrap().os_enabled);
}
