//! The `pika_cjk` FTS5 tokenizer. Text in Chinese, Japanese, and Korean is written without spaces between words, and
//! FTS5's `unicode61` tokenizer keeps a whole run of it as one token, so no word inside the run can match. This tokenizer
//! indexes each such run as its overlapping pairs of characters, as Lucene's `CJKAnalyzer` does: `数据库连接` becomes
//! `数据 据库 库连 连接`, and a query, tokenized the same way, matches wherever its characters appear together, with
//! no dictionary to miss new words. A run of one character is one token. All other text goes to `unicode61` with the
//! arguments the table gives, unchanged.
//!
//! FTS5 tokenizes queries and snippets with it as well, so every connection registers it before it uses `search_fts`.

use std::ffi::{CStr, c_char, c_int, c_void};
use std::ops::Range;
use std::ptr;

use rusqlite::{Connection, ffi};

const NAME: &CStr = c"pika_cjk";
const BASE: &CStr = c"unicode61";

/// Han, kana, and Hangul letters, and the ideographic marks used within words; not CJK punctuation or spaces, which
/// separate tokens as any punctuation does.
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3005 | 0x3007 | 0x3021..=0x3029 | 0x3038..=0x303B // 々, 〇, Hangzhou numerals
        | 0x3041..=0x3096 | 0x309D..=0x309F // hiragana
        | 0x30A1..=0x30FA | 0x30FC..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9F // katakana, without ・
        | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x323AF // Han
        | 0x1100..=0x11FF | 0x3131..=0x318E | 0xA960..=0xA97F | 0xAC00..=0xD7A3 | 0xD7B0..=0xD7FF // Hangul
    )
}

/// A piece of the text, by byte range: text for the base tokenizer, or one token of CJK characters.
#[derive(Debug, PartialEq, Eq)]
enum Piece {
    Base(Range<usize>),
    Token(Range<usize>),
}

/// Calls `f` with the pieces of `text` in order: the text between CJK runs, and each run's pairs of characters (a run
/// of one character as itself). Stops at the first error.
fn pieces<E>(text: &str, mut f: impl FnMut(Piece) -> Result<(), E>) -> Result<(), E> {
    let mut plain = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((start, c)) = chars.next() {
        if !is_cjk(c) {
            continue;
        }
        if plain < start {
            f(Piece::Base(plain..start))?;
        }
        let (mut previous, mut end) = (start, start + c.len_utf8());
        while let Some(&(next, c)) = chars.peek()
            && is_cjk(c)
        {
            chars.next();
            let next_end = next + c.len_utf8();
            f(Piece::Token(previous..next_end))?;
            (previous, end) = (next, next_end);
        }
        if previous == start {
            f(Piece::Token(start..end))?;
        }
        plain = end;
    }
    if plain < text.len() {
        f(Piece::Base(plain..text.len()))?;
    }
    Ok(())
}

type TokenCallback = unsafe extern "C" fn(*mut c_void, c_int, *const c_char, c_int, c_int, c_int) -> c_int;

/// The base tokenizer as one connection's FTS5 found it: the registration's user data.
struct Base {
    user_data: *mut c_void,
    methods: ffi::fts5_tokenizer,
}

/// A `pika_cjk` instance: an instance of the base tokenizer made with the same arguments.
struct Instance {
    base: *mut ffi::Fts5Tokenizer,
    methods: ffi::fts5_tokenizer,
}

/// The context of the base tokenizer's callback: its tokens' offsets are within one piece, starting at `offset`.
struct Shift {
    ctx: *mut c_void,
    token: TokenCallback,
    offset: c_int,
}

fn failure(code: c_int, message: &str) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(ffi::Error::new(code), Some(message.to_owned()))
}

/// Registers `pika_cjk` with the connection's FTS5.
pub fn register(conn: &Connection) -> rusqlite::Result<()> {
    // SAFETY: the handle is open while `conn` is borrowed, and FTS5 owns `base` from its registration on, freeing it
    // with `destroy` when the connection closes.
    unsafe {
        let db = conn.handle();
        let api = fts5_api(db)?;
        let (Some(find), Some(create_tokenizer)) = ((*api).xFindTokenizer, (*api).xCreateTokenizer) else {
            return Err(failure(ffi::SQLITE_ERROR, "FTS5 cannot register tokenizers"));
        };
        let mut base = Base { user_data: ptr::null_mut(), methods: ffi::fts5_tokenizer { xCreate: None, xDelete: None, xTokenize: None } };
        let rc = find(api, BASE.as_ptr(), &mut base.user_data, &mut base.methods);
        if rc != ffi::SQLITE_OK {
            return Err(failure(rc, "FTS5 has no base tokenizer"));
        }
        let mut methods = ffi::fts5_tokenizer { xCreate: Some(create), xDelete: Some(delete), xTokenize: Some(tokenize) };
        let base = Box::into_raw(Box::new(base));
        let rc = create_tokenizer(api, NAME.as_ptr(), base.cast(), &mut methods, Some(destroy));
        if rc != ffi::SQLITE_OK {
            // A failed registration does not call the destructor.
            drop(Box::from_raw(base));
            return Err(failure(rc, "registering the pika_cjk tokenizer"));
        }
    }
    Ok(())
}

/// The connection's `fts5_api`, which `SELECT fts5(?1)` stores through a bound pointer.
unsafe fn fts5_api(db: *mut ffi::sqlite3) -> rusqlite::Result<*mut ffi::fts5_api> {
    let mut stmt = ptr::null_mut();
    let mut api: *mut ffi::fts5_api = ptr::null_mut();
    // SAFETY: `api` outlives the statement, which is finalized before it is read.
    unsafe {
        let rc = ffi::sqlite3_prepare_v2(db, c"SELECT fts5(?1)".as_ptr(), -1, &mut stmt, ptr::null_mut());
        if rc != ffi::SQLITE_OK {
            return Err(failure(rc, "SQLite has no FTS5"));
        }
        ffi::sqlite3_bind_pointer(stmt, 1, (&mut api as *mut *mut ffi::fts5_api).cast(), c"fts5_api_ptr".as_ptr(), None);
        ffi::sqlite3_step(stmt);
        ffi::sqlite3_finalize(stmt);
    }
    if api.is_null() {
        return Err(failure(ffi::SQLITE_ERROR, "SQLite has no FTS5"));
    }
    Ok(api)
}

unsafe extern "C" fn destroy(base: *mut c_void) {
    // SAFETY: `register` passed a boxed `Base`, which FTS5 frees once.
    drop(unsafe { Box::from_raw(base.cast::<Base>()) });
}

unsafe extern "C" fn create(base: *mut c_void, args: *mut *const c_char, n: c_int, out: *mut *mut ffi::Fts5Tokenizer) -> c_int {
    // SAFETY: `base` is the registration's `Base`; FTS5 gives `args` and `out` as its tokenizers' `xCreate` takes them.
    unsafe {
        let base = &*base.cast::<Base>();
        let Some(base_create) = base.methods.xCreate else { return ffi::SQLITE_ERROR };
        let mut instance = ptr::null_mut();
        let rc = base_create(base.user_data, args, n, &mut instance);
        if rc != ffi::SQLITE_OK {
            return rc;
        }
        *out = Box::into_raw(Box::new(Instance { base: instance, methods: base.methods })).cast();
    }
    ffi::SQLITE_OK
}

unsafe extern "C" fn delete(instance: *mut ffi::Fts5Tokenizer) {
    // SAFETY: `create` made `instance`, and FTS5 deletes it once.
    unsafe {
        let instance = Box::from_raw(instance.cast::<Instance>());
        if let Some(base_delete) = instance.methods.xDelete {
            base_delete(instance.base);
        }
    }
}

unsafe extern "C" fn shifted(ctx: *mut c_void, flags: c_int, token: *const c_char, n: c_int, start: c_int, end: c_int) -> c_int {
    // SAFETY: `tokenize` passes a `Shift` that outlives the base tokenizer's call.
    unsafe {
        let shift = &*ctx.cast::<Shift>();
        (shift.token)(shift.ctx, flags, token, n, start + shift.offset, end + shift.offset)
    }
}

unsafe extern "C" fn tokenize(
    instance: *mut ffi::Fts5Tokenizer,
    ctx: *mut c_void,
    flags: c_int,
    text: *const c_char,
    n: c_int,
    token: Option<TokenCallback>,
) -> c_int {
    // SAFETY: `create` made `instance`, and FTS5 gives `n` bytes of `text`.
    let instance = unsafe { &*instance.cast::<Instance>() };
    let (Some(token), Some(base_tokenize)) = (token, instance.methods.xTokenize) else { return ffi::SQLITE_ERROR };
    let bytes: &[u8] = if text.is_null() || n <= 0 { &[] } else { unsafe { std::slice::from_raw_parts(text.cast(), n as usize) } };
    let base = |range: Range<usize>| {
        let mut shift = Shift { ctx, token, offset: range.start as c_int };
        // SAFETY: the range is within `text`.
        let rc = unsafe {
            base_tokenize(instance.base, (&mut shift as *mut Shift).cast(), flags, text.add(range.start), range.len() as c_int, Some(shifted))
        };
        if rc == ffi::SQLITE_OK { Ok(()) } else { Err(rc) }
    };
    // Text that is not UTF-8 has no characters to pair.
    let Ok(text_str) = std::str::from_utf8(bytes) else { return base(0..bytes.len()).err().unwrap_or(ffi::SQLITE_OK) };
    let result = pieces(text_str, |piece| match piece {
        Piece::Base(range) => base(range),
        Piece::Token(range) => {
            // SAFETY: the range is within `text`.
            let rc = unsafe { token(ctx, 0, text.add(range.start), range.len() as c_int, range.start as c_int, range.end as c_int) };
            if rc == ffi::SQLITE_OK { Ok(()) } else { Err(rc) }
        }
    });
    result.err().unwrap_or(ffi::SQLITE_OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(text: &str) -> Vec<(bool, &str)> {
        let mut out = Vec::new();
        pieces(text, |piece| {
            out.push(match piece {
                Piece::Base(r) => (false, &text[r]),
                Piece::Token(r) => (true, &text[r]),
            });
            Ok::<_, ()>(())
        })
        .unwrap();
        out
    }

    #[test]
    fn cjk_runs_become_pairs_and_the_rest_goes_to_the_base() {
        assert_eq!(split(""), []);
        assert_eq!(split("plain text"), [(false, "plain text")]);
        assert_eq!(split("数据库连接"), [(true, "数据"), (true, "据库"), (true, "库连"), (true, "连接")]);
        assert_eq!(
            split("Fix 数据库, 缓存。我 ok"),
            [(false, "Fix "), (true, "数据"), (true, "据库"), (false, ", "), (true, "缓存"), (false, "。"), (true, "我"), (false, " ok")]
        );
        assert_eq!(split("a数b"), [(false, "a"), (true, "数"), (false, "b")]);
        // Kana and kanji pair together; the katakana middle dot separates.
        assert_eq!(split("東京タワー・駅"), [(true, "東京"), (true, "京タ"), (true, "タワ"), (true, "ワー"), (false, "・"), (true, "駅")]);
        assert_eq!(split("서울에서"), [(true, "서울"), (true, "울에"), (true, "에서")]);
        assert_eq!(split("𠀀𠀁"), [(true, "𠀀𠀁")]);
    }

    fn table(conn: &Connection, name: &str, tokenizer: &str, texts: &[&str]) {
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE {name} USING fts5(text, tokenize = \"{tokenizer} remove_diacritics 2 categories 'L* N* Co So'\");
             CREATE VIRTUAL TABLE {name}_terms USING fts5vocab({name}, 'instance');"
        ))
        .unwrap();
        for text in texts {
            conn.execute(&format!("INSERT INTO {name} (text) VALUES (?1)"), [text]).unwrap();
        }
    }

    fn tokens(conn: &Connection, name: &str) -> Vec<(i64, String, i64)> {
        conn.prepare(&format!("SELECT doc, term, offset FROM {name}_terms ORDER BY doc, offset, term"))
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        register(&conn).unwrap();
        conn
    }

    /// Text without CJK characters gets exactly the base tokenizer's tokens, with the table's arguments.
    #[test]
    fn other_text_tokenizes_as_the_base_does() {
        let conn = connection();
        let texts = ["Café naïve ÜBER test_widget_spin 🌀 x-ray", "", "  ", "ENOENT: no such file, '/tmp/a.txt'", "Ünïcödé 12.5 v2"];
        table(&conn, "base", BASE.to_str().unwrap(), &texts);
        table(&conn, "cjk", "pika_cjk", &texts);
        assert_eq!(tokens(&conn, "cjk"), tokens(&conn, "base"));
        assert!(tokens(&conn, "cjk").iter().any(|(_, t, _)| t == "cafe"));
    }

    /// Matches agree with a substring scan for CJK words of two or more characters, in either script mix; snippets
    /// mark the matched characters.
    #[test]
    fn cjk_words_match_wherever_they_appear() {
        let conn = connection();
        let texts = [
            "使用缓存测试数据库连接失败",
            "Fix the 数据库 connection: 缓存未命中",
            "日本語のテスト、東京タワー",
            "서울에서 회사를 다닙니다",
            "缓 存",
        ];
        table(&conn, "t", "pika_cjk", &texts);
        let found = |q: &str| -> Vec<i64> {
            conn.prepare("SELECT rowid FROM t WHERE t MATCH ?1 ORDER BY rowid").unwrap().query_map([q], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
        };
        let scan = |word: &str| -> Vec<i64> {
            texts.iter().enumerate().filter(|(_, t)| t.contains(word)).map(|(i, _)| i as i64 + 1).collect()
        };
        for word in ["缓存", "数据库", "数据库连接", "连接失败", "测试", "東京", "テスト", "회사", "서울", "库连", "命中"] {
            assert_eq!(found(&format!("\"{word}\"")), scan(word), "{word}");
        }
        assert_eq!(found("\"数据库\" \"connection\""), [2]);
        assert_eq!(found("\"the 数据库\""), [2]);
        assert_eq!(found("\"fix 数据库\""), Vec::<i64>::new());
        // A word split by a space is two runs; a single character matches only where it stands alone.
        assert_eq!(found("\"缓\""), [5]);
        assert_eq!(found("\"缓\"*"), [1, 2, 5]);
        assert_eq!(found("\"数据\"*"), [1, 2]);
        let snippet: String = conn
            .query_row("SELECT snippet(t, 0, '[', ']', '…', 24) FROM t WHERE t MATCH '\"数据库\"' AND rowid = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(snippet, "Fix the [数据库] connection: 缓存未命中");
        let snippet: String = conn
            .query_row("SELECT snippet(t, 0, '[', ']', '…', 24) FROM t WHERE t MATCH '\"缓存\"' AND rowid = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(snippet, "使用[缓存]测试数据库连接失败");
    }

    /// Without a registration the table cannot be used, so every connection must register.
    #[test]
    fn a_table_needs_the_registration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let conn = Connection::open(&path).unwrap();
        register(&conn).unwrap();
        table(&conn, "t", "pika_cjk", &["缓存"]);
        drop(conn);
        let plain = Connection::open(&path).unwrap();
        let err = plain.query_row("SELECT count(*) FROM t WHERE t MATCH '缓存'", [], |r| r.get::<_, i64>(0)).unwrap_err();
        assert!(err.to_string().contains("no such tokenizer"), "{err}");
        register(&plain).unwrap();
        assert_eq!(plain.query_row("SELECT count(*) FROM t WHERE t MATCH '缓存'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }
}
