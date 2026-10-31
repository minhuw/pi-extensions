-- Schema version 7: the full-text index gets a prefix index for 3-character prefixes, so that search as you type finds
-- a 3-letter prefix as fast as a whole word, and the `pika_cjk` tokenizer (see tokenizer.rs), which indexes Chinese,
-- Japanese, and Korean text as overlapping pairs of characters. Rebuilding the index from `search_docs` reads every
-- document; no other derived table changes.
DROP TABLE search_fts;
CREATE VIRTUAL TABLE search_fts USING fts5(
    text,
    content = 'search_docs',
    content_rowid = 'id',
    prefix = '3',
    tokenize = "pika_cjk remove_diacritics 2 categories 'L* N* Co So'"
);
INSERT INTO search_fts (search_fts) VALUES ('rebuild');
