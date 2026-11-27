use std::collections::BTreeMap;

/// Names that indicate a CJK-capable font even when the family is spelled in
/// Latin letters, so they can be grouped with the localized names.
const CJK_FONT_NAME_HINTS: &[&str] = &[
    "fangsong",
    "kaiti",
    "simsun",
    "nsimsun",
    "simhei",
    "microsoft yahei",
    "microsoft jhenghei",
    "dengxian",
    "mingliu",
    "pmingliu",
    "dfkai",
    "noto sans cjk",
    "noto serif cjk",
    "source han",
    "pingfang",
    "hiragino",
    "malgun gothic",
    "yu gothic",
    "ms gothic",
    "meiryo",
];

fn is_cjk_font_family(name: &str) -> bool {
    if name.chars().any(|ch| {
        matches!(ch as u32,
            0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2FA1F)
    }) {
        return true;
    }
    let lower = name.to_lowercase();
    CJK_FONT_NAME_HINTS.iter().any(|hint| lower.contains(hint))
}

/// Deduplicate family names case-insensitively while preserving the first
/// spelling seen. CJK-capable families are listed first so Chinese fonts are
/// easy to find, then the remaining families are sorted alphabetically.
///
/// Every installed family is kept, including regular-only CJK fonts such as
/// FangSong/KaiTi/SimSun that ship no semibold face.
pub(crate) fn sorted_font_families<I>(families: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut by_key: BTreeMap<String, String> = BTreeMap::new();
    for family in families {
        let family = family.trim().to_string();
        if family.is_empty() {
            continue;
        }
        by_key.entry(family.to_lowercase()).or_insert(family);
    }
    let mut families: Vec<String> = by_key.into_values().collect();
    families.sort_by(|a, b| {
        is_cjk_font_family(b)
            .cmp(&is_cjk_font_family(a))
            .then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
            .then_with(|| a.cmp(b))
    });
    families
}

fn load_system_font_families() -> Vec<String> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    sorted_font_families(
        database
            .faces()
            .flat_map(|face| face.families.iter().map(|(name, _)| name.clone())),
    )
}

#[tauri::command]
pub(crate) async fn list_system_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(load_system_font_families)
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::sorted_font_families;

    fn families(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|name| (*name).to_string()).collect()
    }

    #[test]
    fn dedupes_trims_and_sorts_case_insensitively() {
        let result = sorted_font_families(families(&[
            "Zilla Slab",
            " inter ",
            "Inter",
            "",
            "arial",
        ]));
        assert_eq!(result, vec!["arial", "inter", "Zilla Slab"]);
    }

    #[test]
    fn keeps_families_without_a_bold_face() {
        let result = sorted_font_families(families(&[
            "仿宋",
            "FangSong",
            "宋体",
            "SimSun",
            "楷体",
        ]));
        assert_eq!(result, vec!["FangSong", "SimSun", "仿宋", "宋体", "楷体"]);
    }

    #[test]
    fn lists_cjk_fonts_before_latin_ones() {
        let result = sorted_font_families(families(&[
            "Zilla Slab",
            "仿宋",
            "Arial",
            "Microsoft YaHei",
            "SimSun",
        ]));
        assert_eq!(
            result,
            vec!["Microsoft YaHei", "SimSun", "仿宋", "Arial", "Zilla Slab"],
        );
    }

    #[test]
    fn command_is_registered() {
        let source = include_str!("lib.rs");
        let handler = source
            .split_once("tauri::generate_handler![")
            .and_then(|(_, rest)| rest.split_once("])").map(|(commands, _)| commands))
            .expect("Tauri command handler should be present");
        assert!(handler.contains("list_system_fonts,"));
    }
}
