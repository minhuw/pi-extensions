CREATE TABLE visitor_day_key (day TEXT PRIMARY KEY, key BLOB NOT NULL, row_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE visitor_views (
    day TEXT NOT NULL,
    country TEXT NOT NULL,
    project TEXT NOT NULL,
    visitor BLOB NOT NULL,
    views INTEGER NOT NULL,
    PRIMARY KEY(day, country, project, visitor)
) WITHOUT ROWID;
