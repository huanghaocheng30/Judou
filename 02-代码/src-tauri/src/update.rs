//! M7 D0 · 更新检查（**离线优先**，不引 HTTP 依赖）。
//!
//! 契约（02 §三.1 裁定）：`Cargo.toml` 里没有 `reqwest`/`ureq`/`tauri-plugin-http`，
//! 本包**不新增网络依赖**——为一个可选功能引入 HTTP 栈（含 TLS/证书根）会显著增大二进制
//! 与供应链面，不值当。所以这里只做「读本地 manifest 文件并与当前版本比较」：
//!
//! - 文件不存在 → `{available:false, reason:"no-manifest"}`
//! - 有更新 → `{available:true, version, notes, url}`
//! - 版本不新 → `{available:false, reason:"up-to-date"}`
//! - 任何解析/IO 错误 → `{available:false, reason:"offline"}`（**不抛错、不阻塞启动**，02 §三.4）
//!
//! 联网检查归 M7 后续（README 已写明）。届时只需把 `check_update` 的取文件那一步换成
//! 拉远端 `latest.json`，解析与版本比较（`parse_manifest` / `is_newer`）原样复用。
//!
//! ponytail: 版本比较用三位数字就地拆，不引 `semver` crate——manifest 由本仓库脚本生成，
//! 形态受控；等真出现 `1.2.3-beta.1` 之类的比较需求再上 crate（升级路径就这一句）。

use std::path::Path;

use serde::{Deserialize, Serialize};

/// `check_update` 返回体（前端 `UpdateResult`，边界 camelCase）。
///
/// 三态由 `available` + `reason` 表达：`available=true` 时 `version` 必有；
/// `available=false` 时 `reason` 说明原因，**前端只按文案降级、不显示技术细节**（AC7）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub url: Option<String>,
    pub reason: Option<String>,
}

impl UpdateResult {
    fn degrade(reason: &str) -> Self {
        Self {
            available: false,
            version: None,
            notes: None,
            url: None,
            reason: Some(reason.to_string()),
        }
    }
}

/// manifest 解析结果（内部用；`version` 已校验非空）
#[derive(Debug, Clone, PartialEq)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub url: Option<String>,
}

/// 解析 Tauri updater v2 形态的 `latest.json`（02 §三.2）：
/// `{"version","pub_date","platforms":{"windows-x86_64":{"signature","url"}}}`。
///
/// 容错口径：`version` 缺失或空串 → `Err`（没有版本就无从比较，不猜）；
/// `platforms` 缺失 / 空对象 → 仍算解析成功，只是 `url` 为 `None`
/// （下载地址拿不到不该让「有没有新版」也答不出来）。
pub fn parse_manifest(json: &str) -> Result<UpdateInfo, String> {
    #[derive(Deserialize)]
    struct RawPlatform {
        #[serde(default)]
        url: Option<String>,
    }

    #[derive(Deserialize)]
    struct RawManifest {
        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        notes: Option<String>,
        #[serde(default)]
        platforms: Option<std::collections::BTreeMap<String, RawPlatform>>,
        /// 非标准但常见：顶层直给 `url`（自建静态托管的简化 manifest）
        #[serde(default)]
        url: Option<String>,
    }

    let raw: RawManifest = serde_json::from_str(json).map_err(|err| format!("manifest 不是合法 JSON：{err}"))?;
    let version = raw.version.unwrap_or_default().trim().to_string();
    if version.is_empty() {
        return Err("manifest 缺 version".to_string());
    }

    // 平台条目优先级：Windows（本应用主发布平台）→ 任意带 url 的条目
    let mut url = raw.url;
    if url.is_none() {
        if let Some(platforms) = raw.platforms.as_ref() {
            url = platforms
                .get("windows-x86_64")
                .and_then(|p| p.url.clone())
                .or_else(|| platforms.values().find_map(|p| p.url.clone()));
        }
    }
    let notes = raw.notes.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());

    Ok(UpdateInfo { version, notes, url })
}

/// 三位数字版本 → 元组；带 `v` 前缀、`-pre`/`+build` 后缀都能认（后缀不参与比较）。
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches(['v', 'V']);
    let core = core.split(['-', '+']).next()?;
    if core.is_empty() {
        return None;
    }
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    Some((major, minor, patch))
}

/// `candidate` 是否比 `current` 新。**任一侧解析不出就返回 false**（判不清当「没有新版」，
/// 宁可少提示一次也不误报升级——降级优先，02 §三.4）。
pub fn is_newer(current: &str, candidate: &str) -> bool {
    match (parse_version(current), parse_version(candidate)) {
        (Some(cur), Some(cand)) => cand > cur,
        _ => false,
    }
}

/// manifest 路径：环境变量 `JUDOU_UPDATE_MANIFEST` 优先（自测/侧载用），
/// 否则取应用数据目录下的 `latest.json`（与 `judou.db` 同级）。
pub fn resolve_manifest_path(app_data_dir: Option<&Path>) -> Option<std::path::PathBuf> {
    if let Ok(raw) = std::env::var("JUDOU_UPDATE_MANIFEST") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(std::path::PathBuf::from(trimmed));
        }
    }
    app_data_dir.map(|dir| dir.join("latest.json"))
}

/// 离线检查更新：读 manifest 文件 → 解析 → 比版本。**任何失败都降级成 `available:false`**。
pub fn check_update(current_version: &str, manifest_path: Option<&Path>) -> UpdateResult {
    let Some(path) = manifest_path else {
        return UpdateResult::degrade("no-manifest");
    };
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        // 文件不存在是「还没发布过 manifest」的正常状态，与「读坏了」分开报
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return UpdateResult::degrade("no-manifest");
        }
        Err(_) => return UpdateResult::degrade("offline"),
    };
    let info = match parse_manifest(&text) {
        Ok(info) => info,
        Err(_) => return UpdateResult::degrade("offline"),
    };
    if !is_newer(current_version, &info.version) {
        return UpdateResult::degrade("up-to-date");
    }
    UpdateResult {
        available: true,
        version: Some(info.version),
        notes: info.notes,
        url: info.url,
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    const WIN_MANIFEST: &str = r#"{
        "version": "0.2.0",
        "notes": "  新增 AI 解析导入  ",
        "pub_date": "2026-11-08T00:00:00Z",
        "platforms": {
            "windows-x86_64": { "signature": "sig==", "url": "https://example.com/judou_0.2.0_x64-setup.exe" }
        }
    }"#;

    /// 临时文件（进程内自增计数，避免并行测试撞名）
    fn temp_manifest(body: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "judou-update-test-{}-{}.json",
            std::process::id(),
            seq
        ));
        std::fs::write(&path, body).expect("写临时 manifest 失败");
        path
    }

    /// 单测 1：正常 manifest → version/notes(已 trim)/url 三项都取到
    #[test]
    fn parse_manifest_reads_tauri_updater_format() {
        let info = parse_manifest(WIN_MANIFEST).expect("应解析成功");
        assert_eq!(info.version, "0.2.0");
        assert_eq!(info.notes.as_deref(), Some("新增 AI 解析导入"));
        assert_eq!(
            info.url.as_deref(),
            Some("https://example.com/judou_0.2.0_x64-setup.exe")
        );
    }

    /// 单测 2：缺 version / 非法 JSON → Err（不猜版本）；缺 platforms → url=None 但仍解析成功
    #[test]
    fn parse_manifest_rejects_missing_version_but_tolerates_empty_platforms() {
        assert!(parse_manifest("{\"version\":\"\"}").is_err());
        assert!(parse_manifest("{\"pub_date\":\"2026-11-08T00:00:00Z\"}").is_err());
        assert!(parse_manifest("not json at all").is_err());

        let info = parse_manifest("{\"version\":\"1.0.0\"}").expect("缺 platforms 不算错");
        assert_eq!(info.version, "1.0.0");
        assert_eq!(info.url, None);
    }

    /// 单测 3：版本比较（含补位、v 前缀、预发布后缀、多位补丁号）
    #[test]
    fn is_newer_compares_three_part_versions() {
        assert!(is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("0.1.9", "0.1.10"));
        assert!(is_newer("0.1", "0.1.1"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("v0.1.0", "v0.2.0"));
        assert!(is_newer("0.1.0", "0.2.0-beta.1"));
        // 解析不出 → 一律「不算新版」（降级优先，不误报）
        assert!(!is_newer("0.1.0", "latest"));
    }

    /// 单测 4：manifest 不存在 → reason="no-manifest"，不报错
    #[test]
    fn check_update_degrades_when_manifest_missing() {
        let missing = std::env::temp_dir().join("judou-update-test-not-exist-xyz.json");
        let result = check_update("0.1.0", Some(missing.as_path()));
        assert!(!result.available);
        assert_eq!(result.reason.as_deref(), Some("no-manifest"));
        assert_eq!(result.version, None);

        // 连路径都没有（应用数据目录都定位不到）
        let none = check_update("0.1.0", None);
        assert!(!none.available);
        assert_eq!(none.reason.as_deref(), Some("no-manifest"));
    }

    /// 单测 5：有新版 → available=true 且三字段齐全
    #[test]
    fn check_update_reports_available_when_newer() {
        let path = temp_manifest(WIN_MANIFEST);
        let result = check_update("0.1.0", Some(path.as_path()));
        assert!(result.available);
        assert_eq!(result.version.as_deref(), Some("0.2.0"));
        assert_eq!(result.reason, None);
        assert!(result.url.is_some());
        let _ = std::fs::remove_file(path);
    }

    /// 单测 6：同版本 → available=false + reason="up-to-date"；坏文件 → reason="offline"
    #[test]
    fn check_update_degrades_on_same_version_and_broken_manifest() {
        let same = temp_manifest(WIN_MANIFEST);
        let result = check_update("0.2.0", Some(same.as_path()));
        assert!(!result.available);
        assert_eq!(result.reason.as_deref(), Some("up-to-date"));
        let _ = std::fs::remove_file(same);

        let broken = temp_manifest("{ 这不是 JSON");
        let bad = check_update("0.1.0", Some(broken.as_path()));
        assert!(!bad.available);
        assert_eq!(bad.reason.as_deref(), Some("offline"));
        let _ = std::fs::remove_file(broken);
    }
}
