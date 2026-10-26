use sha2::{Digest, Sha256};

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("system randomness unavailable");
    buf
}

/// A random 32-byte secret as unpadded base64url: 43 characters.
pub fn random_secret() -> String {
    use base64ct::Encoding;
    base64ct::Base64UrlUnpadded::encode_string(&random_bytes::<32>())
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Cuts `s` to at most `max` characters.
pub fn cut_chars(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// Cuts `s` to at most `max` bytes at a character boundary.
pub fn cut_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Parses JSON like `serde_json::from_str`, but on failure retries with every `\uXXXX` escape of an unpaired UTF-16
/// surrogate replaced by `\uFFFD`. `JSON.stringify` writes such escapes for strings cut between the halves of a pair,
/// and Rust strings cannot hold them.
pub fn parse_json_lenient(text: &str) -> serde_json::Result<serde_json::Value> {
    serde_json::from_str(text).or_else(|e| match replace_lone_surrogates(text) {
        Some(fixed) => serde_json::from_str(&fixed),
        None => Err(e),
    })
}

fn surrogate_escape(b: &[u8], i: usize) -> Option<u16> {
    let hex = b.get(i..i + 6).filter(|e| e.starts_with(b"\\u"))?;
    let n = u16::from_str_radix(std::str::from_utf8(&hex[2..]).ok()?, 16).ok()?;
    (0xD800..=0xDFFF).contains(&n).then_some(n)
}

/// `text` with unpaired surrogate escapes replaced by `\uFFFD`, or `None` when it has none.
fn replace_lone_surrogates(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let mut out = String::new();
    let (mut copied, mut i) = (0, 0);
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        let Some(n) = surrogate_escape(b, i) else {
            i += 2;
            continue;
        };
        if n < 0xDC00 && surrogate_escape(b, i + 6).is_some_and(|low| low >= 0xDC00) {
            i += 12;
            continue;
        }
        out.push_str(&text[copied..i]);
        out.push_str("\\uFFFD");
        i += 6;
        copied = i;
    }
    (copied > 0).then(|| out + &text[copied..])
}

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Percent-encodes everything but RFC 3986 unreserved characters, for one URL path segment.
pub fn encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

const BASE64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// URL-safe base64 without padding.
pub fn base64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..chunk.len() + 1 {
            out.push(BASE64_URL[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// Decodes standard or URL-safe base64, with or without padding; ASCII whitespace is skipped.
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    let mut padding = false;
    for b in s.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => {
                padding = true;
                continue;
            }
            b if b.is_ascii_whitespace() => continue,
            _ => return None,
        };
        if padding {
            return None;
        }
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    (bits < 6).then_some(out)
}

/// The last path component, for both `/` and `\` separators.
pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]` into Unix milliseconds. A missing offset means UTC.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter().all(u8::is_ascii_digit).then(|| std::str::from_utf8(part).ok()?.parse().ok())?
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hour, minute, second) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut i = 19;
    let mut millis = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let digits = &s[start..i];
        if digits.is_empty() {
            return None;
        }
        let padded = format!("{:0<3}", &digits[..digits.len().min(3)]);
        millis = padded.parse::<i64>().ok()?;
    }
    let offset_min = match b.get(i) {
        None => 0,
        Some(b'Z' | b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if b.len() == i + 6 && b[i + 3] == b':' => {
            let minutes = num(i + 1, 2)? * 60 + num(i + 4, 2)?;
            if *sign == b'+' { minutes } else { -minutes }
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day);
    Some(((days * 24 + hour) * 60 + minute - offset_min) * 60_000 + second * 1000 + millis)
}

pub fn format_iso_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trip() {
        let ms = parse_iso_ms("2024-12-03T14:00:01.250Z").unwrap();
        assert_eq!(ms, 1733234401250);
        assert_eq!(format_iso_ms(ms), "2024-12-03T14:00:01.250Z");
        assert_eq!(parse_iso_ms("2024-12-03T15:00:01.25+01:00"), Some(ms));
        assert_eq!(parse_iso_ms("2024-12-03T14:00:01"), Some(1733234401000));
        assert_eq!(parse_iso_ms("1969-12-31T23:59:59.999Z"), Some(-1));
        assert_eq!(parse_iso_ms("garbage"), None);
    }

    #[test]
    fn hmac_matches_rfc4231() {
        let key = [0x0bu8; 20];
        assert_eq!(
            hex::encode(hmac_sha256(&key, b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn helpers() {
        assert_eq!(cut_chars("héllo", 2), "hé");
        assert_eq!(basename("/a/b/repo/"), "repo");
        assert_eq!(basename("C:\\x\\y"), "y");
        assert_eq!(cut_bytes("héllo", 2), "h");
        assert_eq!(escape_html("<a href='x'>&\""), "&lt;a href=&#39;x&#39;&gt;&amp;&quot;");
        assert_eq!(encode_path_segment("a b/ü-1"), "a%20b%2F%C3%BC-1");
    }

    #[test]
    fn lone_surrogate_escapes_parse_as_replacement_characters() {
        let parse = |text: &str| parse_json_lenient(text).unwrap();
        assert_eq!(parse(r#""a\ud83d""#), "a\u{fffd}");
        assert_eq!(parse(r#"["\udc00x", "\ud83d\ude00", "\\ud83d", "\uD83D\uD83D\uDE00"]"#), serde_json::json!(["\u{fffd}x", "😀", "\\ud83d", "\u{fffd}😀"]));
        assert_eq!(parse(r#"{"k": "\ud83d\n\ud83d"}"#), serde_json::json!({ "k": "\u{fffd}\n\u{fffd}" }));
        assert!(parse_json_lenient(r#"{"k": "\ud83d"#).is_err());
        assert!(parse_json_lenient("nope").is_err());
    }

    #[test]
    fn base64() {
        for (plain, encoded) in [("", ""), ("f", "Zg"), ("fo", "Zm8"), ("foo", "Zm9v"), ("foob", "Zm9vYg"), ("\u{ff}\u{fe}?", "w7_Dvj8")] {
            assert_eq!(base64url_encode(plain.as_bytes()), encoded);
            assert_eq!(base64_decode(encoded).unwrap(), plain.as_bytes());
        }
        assert_eq!(base64_decode("aGVs\nbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("w7/Dvj8=").unwrap(), "\u{ff}\u{fe}?".as_bytes());
        assert!(base64_decode("a").is_none());
        assert!(base64_decode("ab=c").is_none());
        assert!(base64_decode("a*b").is_none());
    }
}
