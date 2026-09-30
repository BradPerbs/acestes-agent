const { app } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * The runs database.
 *
 * One SQLite file under userData, opened once, in WAL mode, through the
 * `node:sqlite` module Electron's Node carries. No native build, no second
 * process, no timer between an effect and its record: a write here is on
 * disk when the call returns, which is the whole reason the run log is not
 * another JSON file coalesced on a timer like the conversation archive.
 *
 * Schema changes are numbered migrations applied in order; the version is
 * kept in `user_version` so a file written by an older build is brought
 * forward rather than refused.
 */

let db = null;

const MIGRATIONS = [
    `
    CREATE TABLE runs (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        status      TEXT NOT NULL,
        trigger     TEXT NOT NULL DEFAULT '{}',
        policy      TEXT NOT NULL DEFAULT '{}',
        conversation_id TEXT NOT NULL DEFAULT '',
        parent_id   TEXT NOT NULL DEFAULT '',
        job_id      TEXT NOT NULL DEFAULT '',
        title       TEXT NOT NULL DEFAULT '',
        progress    TEXT NOT NULL DEFAULT '',
        result      TEXT NOT NULL DEFAULT '{}',
        cost_usd    REAL NOT NULL DEFAULT 0,
        turns       INTEGER NOT NULL DEFAULT 0,
        tool_calls  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        started_at  INTEGER,
        ended_at    INTEGER,
        updated_at  INTEGER NOT NULL
    );
    CREATE INDEX runs_agent_updated ON runs (agent_id, updated_at DESC);
    CREATE INDEX runs_status ON runs (status);
    CREATE INDEX runs_conversation ON runs (conversation_id);

    CREATE TABLE steps (
        run_id      TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        status      TEXT NOT NULL,
        name        TEXT NOT NULL DEFAULT '',
        input       TEXT NOT NULL DEFAULT '',
        output      TEXT NOT NULL DEFAULT '',
        attempts    INTEGER NOT NULL DEFAULT 1,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        PRIMARY KEY (run_id, seq)
    );
    `,
    `
    CREATE TABLE jobs (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        schedule    TEXT NOT NULL,
        prompt      TEXT NOT NULL DEFAULT '',
        session     TEXT NOT NULL DEFAULT 'isolated',
        policy      TEXT NOT NULL DEFAULT '{}',
        model       TEXT NOT NULL DEFAULT '',
        effort      TEXT NOT NULL DEFAULT '',
        delivery    TEXT NOT NULL DEFAULT '{}',
        missed      TEXT NOT NULL DEFAULT 'skip',
        keep_after_run INTEGER NOT NULL DEFAULT 0,
        created_by  TEXT NOT NULL DEFAULT 'user',
        token       TEXT NOT NULL DEFAULT '',
        last_run_at INTEGER,
        last_status TEXT NOT NULL DEFAULT '',
        next_run_at INTEGER,
        failures    INTEGER NOT NULL DEFAULT 0,
        run_count   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE INDEX jobs_agent ON jobs (agent_id, updated_at DESC);
    CREATE INDEX jobs_due ON jobs (enabled, next_run_at);
    `,
    `
    ALTER TABLE jobs ADD COLUMN provider TEXT NOT NULL DEFAULT '';
    `,
    `
    ALTER TABLE jobs ADD COLUMN template TEXT NOT NULL DEFAULT '';
    CREATE INDEX runs_job ON runs (job_id, updated_at DESC);
    `,
];

function file() {
    return path.join(app.getPath('userData'), 'runs.db');
}

function open() {
    if (db) return db;
    // Loaded lazily and by name, so a test under plain node that never
    // touches the runs does not need the module, and a Node without it
    // fails at the first call with a message that names the reason.
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    db = new DatabaseSync(file());
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
}

function migrate(handle) {
    const current = handle.prepare('PRAGMA user_version').get().user_version || 0;
    for (let version = current; version < MIGRATIONS.length; version += 1) {
        handle.exec('BEGIN');
        try {
            handle.exec(MIGRATIONS[version]);
            handle.exec(`PRAGMA user_version = ${version + 1}`);
            handle.exec('COMMIT');
        } catch (error) {
            handle.exec('ROLLBACK');
            throw error;
        }
    }
}

function close() {
    if (!db) return;
    try {
        db.close();
    } catch {
        // Already closed.
    }
    db = null;
}

/** For tests: point the database somewhere else before it is opened. */
function _reset() {
    close();
}

module.exports = { open, close, file, _reset };
