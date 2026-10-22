//! 局域网候选地址探测，供分享链接和网卡切换使用。

use std::collections::HashSet;

/// 虚拟网卡前缀：这些地址对局域网访客没有意义，直接跳过。
const VIRTUAL_PREFIXES: &[&str] = &[
    "utun", "awdl", "llw", "docker", "vmnet", "vboxnet", "lo", "stf", "gif", "anpi",
];

pub fn candidate_addresses() -> Vec<String> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };

    let mut ranked: Vec<(u8, String, String)> = Vec::new();
    for interface in interfaces {
        let name = interface.name.to_ascii_lowercase();
        if VIRTUAL_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        let ip = match &interface.addr {
            if_addrs::IfAddr::V4(v4) => v4.ip,
            if_addrs::IfAddr::V6(_) => continue,
        };
        if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
            continue;
        }
        let rank = if name.starts_with("en") {
            0
        } else if name.starts_with("wl") || name.starts_with("wlan") {
            1
        } else if name.starts_with("eth") {
            2
        } else {
            3
        };
        ranked.push((rank, name, ip.to_string()));
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
        if VIRTUAL_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
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
        let rank = if name.starts_with("en") {
            0
        } else if name.starts_with("wl") || name.starts_with("wlan") {
            1
        } else if name.starts_with("eth") {
            2
        } else {
            3
        };
        ranked.push((rank, name, format!("[{ip}]")));
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
}
