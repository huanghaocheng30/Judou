//! 命令层：M0 只有 `ping` / `get_settings` / `set_setting`（docs C3 §5.8 契约）。
//! 命令名与入参必须与契约逐字一致：`get_settings` 是**复数**且返回全量键值。

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::db::Db;

/// 统一错误结构（docs D1 §7.2）：`code` / `message` / `path`，camelCase 边界。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl CommandError {
    /// 库读写错误：message 只给用户可读提示，**不带 SQL 细节**（docs D1 §11.9）；
    /// 细节打到 stderr 供开发期诊断（dev 日志可见，不进 IPC 返回）。
    pub fn db(context: &str, err: rusqlite::Error) -> Self {
        eprintln!("[judou][db] {context}: {err}");
        Self {
            code: "db_error".to_string(),
            message: format!("本地库{context}失败，请重试；若持续失败请备份后重启应用。"),
            path: None,
        }
    }

    /// 文件系统类错误（建目录/打开文件）：同样不在 message 里暴露绝对路径
    pub fn db_io(context: &str, detail: impl std::fmt::Display) -> Self {
        eprintln!("[judou][db] {context}: {detail}");
        Self {
            code: "db_error".to_string(),
            message: format!("本地库{context}失败，请检查磁盘权限或剩余空间后重启应用。"),
            path: None,
        }
    }

    pub fn db_busy() -> Self {
        Self {
            code: "db_error".to_string(),
            message: "本地库正忙，请重试。".to_string(),
            path: None,
        }
    }

    /// docs C3 §5.8：只允许已知键
    pub fn invalid_setting_key(key: &str) -> Self {
        Self {
            code: "invalid_setting_key".to_string(),
            message: format!("不支持的设置键：{key}"),
            path: None,
        }
    }

    /// 值非法。C3 §5.8 只登记了 `invalid_setting_key`（键级），
    /// 值级错误用更精确的独立码，避免把「值非法」误报成「键不支持」。
    pub fn invalid_setting_value(key: &str, reason: &str) -> Self {
        Self {
            code: "invalid_setting_value".to_string(),
            message: format!("设置项 {key} 的取值非法：{reason}"),
            path: None,
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

/// `ping` 返回体（前端 `PingResult`，camelCase）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub pong: bool,
    pub app_version: String,
}

/// 连通性探针：appVersion 来自 Cargo 包版本（AC3 断言 0.1.0）
#[tauri::command]
pub fn ping() -> PingResult {
    PingResult {
        pong: true,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// 读 app_setting 全量键值；前端自取 theme，未知键忽略（docs C3 §5.8）
#[tauri::command]
pub fn get_settings(db: State<'_, Db>) -> Result<HashMap<String, String>, CommandError> {
    db.settings()
}

/// 写单个设置键。只允许 docs C3 §5.8 的三个已知键。
#[tauri::command]
pub fn set_setting(db: State<'_, Db>, key: String, value: String) -> Result<(), CommandError> {
    validate_setting(&key, &value)?;
    db.set_setting(&key, &value)
}

/// 设置键/值校验（docs C3 §5.8）：已知键白名单 +
/// `review_intervals` 必须是长度 4 的正整数 JSON 数组 + `theme` 三档。
fn validate_setting(key: &str, value: &str) -> Result<(), CommandError> {
    match key {
        "theme" => {
            if matches!(value, "light" | "dark" | "system") {
                Ok(())
            } else {
                Err(CommandError::invalid_setting_value(key, "只接受 light / dark / system"))
            }
        }
        "guide_shown" => {
            if matches!(value, "0" | "1") {
                Ok(())
            } else {
                Err(CommandError::invalid_setting_value(key, "只接受 0 / 1"))
            }
        }
        "review_intervals" => {
            let parsed: Vec<i64> = serde_json::from_str(value)
                .map_err(|_| CommandError::invalid_setting_value(key, "必须是 JSON 整数数组，例如 [1,3,7,14]"))?;
            if parsed.len() == 4 && parsed.iter().all(|days| *days > 0) {
                Ok(())
            } else {
                Err(CommandError::invalid_setting_value(key, "必须是长度 4 的正整数数组"))
            }
        }
        other => Err(CommandError::invalid_setting_key(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_accepts_three_tiers_only() {
        assert!(validate_setting("theme", "light").is_ok());
        assert!(validate_setting("theme", "dark").is_ok());
        assert!(validate_setting("theme", "system").is_ok());
        assert_eq!(
            validate_setting("theme", "Dark").unwrap_err().code,
            "invalid_setting_value"
        );
    }

    #[test]
    fn unknown_key_is_rejected_with_contract_code() {
        let err = validate_setting("nope", "1").unwrap_err();
        assert_eq!(err.code, "invalid_setting_key");
    }

    #[test]
    fn review_intervals_must_be_four_positive_ints() {
        assert!(validate_setting("review_intervals", "[1,3,7,14]").is_ok());
        assert!(validate_setting("review_intervals", "[1,3,7]").is_err());
        assert!(validate_setting("review_intervals", "[1,3,7,0]").is_err());
        assert!(validate_setting("review_intervals", "1,3,7,14").is_err());
    }
}
