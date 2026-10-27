//! 局域网候选地址探测，供分享链接和网卡切换使用。

use std::collections::HashSet;

/// 虚拟网卡前缀：这些地址对局域网访客没有意义，直接跳过。
const VIRTUAL_PREFIXES: &[&str] = &[
    "utun", "awdl", "llw", "docker", "vmnet", "vboxnet", "stf", "gif", "anpi",
    // Windows 的 Hyper-V/WSL、虚拟机和 VPN 网卡同样不可达；它们常排在物理网卡前面，
    // 若不排除，分享地址/二维码会指向访客无法访问的网段。
    "vethernet", "hyper-v", "wsl", "vmware", "virtualbox", "tailscale", "zerotier",
    "wireguard", "npcap", "tap", "tun", "vpn", "bluetooth",
];

fn is_virtual(name: &str) -> bool {
    name == "lo"
        || name.starts_with("lo0")
        || name.contains("loopback")
        || VIRTUAL_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// 网卡优先级：有线优先于无线，未知网卡最后。
/// Windows 的「vEthernet」也含「ethernet」，所以只按键名前缀匹配。
fn rank_of(name: &str) -> u8 {
    if name.starts_with("en") || name.starts_with("eth") || name.starts_with("ethernet") {
        0
    } else if name.starts_with("wl") || name.starts_with("wlan") || name.contains("wi-fi") {
        1
    } else {
        2
    }
}

pub fn candidate_addresses() -> Vec<String> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };

    let mut ranked: Vec<(u8, String, String)> = Vec::new();
    for interface in interfaces {
        let name = interface.name.to_ascii_lowercase();
        if is_virtual(&name) {
            continue;
        }
        let ip = match &interface.addr {
            if_addrs::IfAddr::V4(v4) => v4.ip,
            if_addrs::IfAddr::V6(_) => continue,
        };
        if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
            continue;
        }
        ranked.push((rank_of(&name), name, ip.to_string()));
    }

    ranked.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let mut seen = HashSet::new();
    ranked
        .into_iter()
        .filter_map(|(_, _, address)| seen.insert(address.clone()).then_some(address))
        .collect()
}

pub fn candidate_addresses_v6() -> Vec<String> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut ranked: Vec<(u8, String, String)> = Vec::new();
    for interface in interfaces {
        let name = interface.name.to_ascii_lowercase();
        if is_virtual(&name) {
            continue;
        }
        let ip = match &interface.addr {
            if_addrs::IfAddr::V6(v6) => v6.ip,
            if_addrs::IfAddr::V4(_) => continue,
        };
        if ip.is_loopback()
            || ip.is_unspecified()
            || ip.is_multicast()
            || ip.is_unicast_link_local()
        {
            continue;
        }
        ranked.push((rank_of(&name), name, format!("[{ip}]")));
    }
    ranked.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let mut seen = HashSet::new();
    ranked
        .into_iter()
        .filter_map(|(_, _, address)| seen.insert(address.clone()).then_some(address))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_unique_and_routable() {
        let addresses = candidate_addresses();
        let unique: HashSet<_> = addresses.iter().collect();
        assert_eq!(addresses.len(), unique.len());
        for address in addresses {
            let parsed: std::net::IpAddr = address.parse().expect("候选地址必须是 IP");
            assert!(!parsed.is_loopback());
        }
    }

    #[test]
    fn windows_adapter_names_are_classified() {
        assert!(is_virtual("vethernet (wsl (hyper-v firewall))"));
        assert!(is_virtual("loopback pseudo-interface 1"));
        assert!(is_virtual("tailscale"));
        assert!(!is_virtual("ethernet"));
        assert!(!is_virtual("wi-fi"));
        assert!(!is_virtual("local area connection"));
        assert!(rank_of("ethernet") < rank_of("wi-fi"));
        assert!(rank_of("en0") < rank_of("wlan"));
    }
}
