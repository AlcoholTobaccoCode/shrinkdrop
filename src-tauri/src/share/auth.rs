//! 访客鉴权：PIN、账号、会话 cookie 与失败锁定。

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub const COOKIE_NAME: &str = "share_auth";
pub const SESSION_TTL: u64 = 12 * 60 * 60;
const MAX_FAILURES: u32 = 5;
const LOCK_DURATION: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protection {
    Link,
    Pin,
    Accounts,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub download: bool,
    pub upload: bool,
    pub text: bool,
}

impl Default for Permissions {
    fn default() -> Self {
        Self {
            download: true,
            upload: false,
            text: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub username: String,
    pub password_hash: String,
    pub permissions: Permissions,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claims {
    pub scope: String,
    pub account: Option<String>,
    pub expires: u64,
}

#[derive(Default)]
struct Attempt {
    failures: u32,
    locked_until: Option<Instant>,
}

pub struct AuthConfig {
    pub protection: Protection,
    pub pin_hash: Option<String>,
    pub accounts: Vec<Account>,
    pub allow_upload: bool,
    pub allow_text: bool,
    pub key: [u8; 32],
    attempts: Mutex<HashMap<IpAddr, Attempt>>,
}

impl AuthConfig {
    pub fn new(
        protection: Protection,
        pin_hash: Option<String>,
        accounts: Vec<Account>,
        allow_upload: bool,
        allow_text: bool,
    ) -> Self {
        Self {
            protection,
            pin_hash,
            accounts,
            allow_upload,
            allow_text,
            key: new_signing_key(),
            attempts: Mutex::new(HashMap::new()),
        }
    }

    pub fn permissions(&self, claims: Option<&Claims>) -> Option<Permissions> {
        match self.protection {
            Protection::Link => Some(Permissions {
                download: true,
                upload: self.allow_upload,
                text: self.allow_text,
            }),
            Protection::Pin => claims
                .filter(|claims| claims.scope == "pin")
                .map(|_| Permissions {
                    download: true,
                    upload: self.allow_upload,
                    text: self.allow_text,
                }),
            Protection::Accounts => {
                let claims = claims?;
                if claims.scope != "account" {
                    return None;
                }
                let id = claims.account.as_ref()?;
                self.accounts
                    .iter()
                    .find(|account| &account.id == id && account.enabled)
                    .map(|account| account.permissions.clone())
            }
        }
    }

    pub fn authenticated(&self, claims: Option<&Claims>) -> bool {
        match self.protection {
            Protection::Link => true,
            _ => self.permissions(claims).is_some(),
        }
    }

    pub fn locked(&self, ip: IpAddr) -> bool {
        let Ok(attempts) = self.attempts.lock() else {
            return false;
        };
        attempts
            .get(&ip)
            .and_then(|attempt| attempt.locked_until)
            .is_some_and(|until| until > Instant::now())
    }

    pub fn record_failure(&self, ip: IpAddr) -> bool {
        let Ok(mut attempts) = self.attempts.lock() else {
            return false;
        };
        let attempt = attempts.entry(ip).or_default();
        attempt.failures += 1;
        if attempt.failures >= MAX_FAILURES {
            attempt.failures = 0;
            attempt.locked_until = Some(Instant::now() + LOCK_DURATION);
            return true;
        }
        false
    }

    pub fn clear_failures(&self, ip: IpAddr) {
        if let Ok(mut attempts) = self.attempts.lock() {
            attempts.remove(&ip);
        }
    }
}

pub fn new_signing_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    if getrandom::fill(&mut key).is_err() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos() as u64)
            .unwrap_or_default();
        key[..8].copy_from_slice(&stamp.to_le_bytes());
    }
    key
}

pub fn hash_secret(secret: &str) -> Result<String, String> {
    let mut salt_bytes = [0u8; 16];
    getrandom::fill(&mut salt_bytes).map_err(|_| "无法生成盐值".to_string())?;
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|_| "无法生成盐值".to_string())?;
    Argon2::default()
        .hash_password(secret.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| "无法保存口令".to_string())
}

pub fn verify_secret(secret: &str, encoded: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(encoded) else {
        return false;
    };
    Argon2::default()
        .verify_password(secret.as_bytes(), &parsed)
        .is_ok()
}

pub fn new_account_id() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return format!("{:x}", std::process::id());
    }
    hex(&bytes)
}

pub fn sign_claims(key: &[u8], claims: &Claims) -> String {
    let payload = hex(&serde_json::to_vec(claims).unwrap_or_default());
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(payload.as_bytes());
    let signature = hex(&mac.finalize().into_bytes());
    format!("{payload}.{signature}")
}

pub fn verify_claims(key: &[u8], token: &str) -> Option<Claims> {
    let (payload, signature) = token.split_once('.')?;
    let signature = unhex(signature)?;
    let mut mac = HmacSha256::new_from_slice(key).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature).ok()?;
    let bytes = unhex(payload)?;
    let claims: Claims = serde_json::from_slice(&bytes).ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    if claims.expires <= now {
        return None;
    }
    Some(claims)
}

pub fn expires_at() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default()
        + SESSION_TTL
}

pub fn cookie_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let cookies = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    cookies.split(';').find_map(|part| {
        let part = part.trim();
        let (name, value) = part.split_once('=')?;
        (name == COOKIE_NAME).then(|| value.to_string())
    })
}

pub fn cookie_header(token: &str, path: &str) -> String {
    format!("{COOKIE_NAME}={token}; Path={path}; HttpOnly; SameSite=Strict; Max-Age={SESSION_TTL}")
}

pub fn clear_cookie(path: &str) -> String {
    format!("{COOKIE_NAME}=; Path={path}; HttpOnly; SameSite=Strict; Max-Age=0")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_and_verifies_secrets() {
        let hash = hash_secret("123456").unwrap();
        assert!(verify_secret("123456", &hash));
        assert!(!verify_secret("654321", &hash));
    }

    #[test]
    fn signs_and_verifies_claims() {
        let key = new_signing_key();
        let claims = Claims {
            scope: "pin".to_string(),
            account: None,
            expires: expires_at(),
        };
        let token = sign_claims(&key, &claims);
        let parsed = verify_claims(&key, &token).unwrap();
        assert_eq!(parsed.scope, "pin");

        let mut tampered = token.clone();
        tampered.push('0');
        assert!(verify_claims(&key, &tampered).is_none());
        assert!(verify_claims(&new_signing_key(), &token).is_none());
    }

    #[test]
    fn rejects_expired_claims() {
        let key = new_signing_key();
        let token = sign_claims(
            &key,
            &Claims {
                scope: "pin".to_string(),
                account: None,
                expires: 1,
            },
        );
        assert!(verify_claims(&key, &token).is_none());
    }

    #[test]
    fn permissions_follow_protection_and_accounts() {
        let account = Account {
            id: "a1".to_string(),
            username: "alice".to_string(),
            password_hash: String::new(),
            permissions: Permissions {
                download: true,
                upload: true,
                text: false,
            },
            enabled: true,
        };
        let config = AuthConfig::new(Protection::Accounts, None, vec![account], false, false);
        assert!(config.permissions(None).is_none());
        let claims = Claims {
            scope: "account".to_string(),
            account: Some("a1".to_string()),
            expires: expires_at(),
        };
        let permissions = config.permissions(Some(&claims)).unwrap();
        assert!(permissions.upload);
        assert!(!permissions.text);
    }

    #[test]
    fn locks_after_five_failures() {
        let config = AuthConfig::new(Protection::Pin, None, Vec::new(), false, false);
        let ip: IpAddr = "10.0.0.2".parse().unwrap();
        for _ in 0..4 {
            assert!(!config.record_failure(ip));
        }
        assert!(config.record_failure(ip));
        assert!(config.locked(ip));
        config.clear_failures(ip);
        assert!(!config.locked(ip));
    }
}
