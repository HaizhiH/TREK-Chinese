import { runMigrations } from '../../../src/db/migrations';
import { createTables } from '../../../src/db/schema';

import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';

// Stop before the requested slot, producing a real historical schema instead
// of merely lowering the version on a database that already has newer columns.
function databaseBefore(slot: number) {
  const db = new Database(':memory:');
  createTables(db);
  const stop = new Error('historical migration boundary');
  const log = vi.spyOn(console, 'log').mockImplementation((message) => {
    if (String(message).startsWith(`[DB] Running migration ${slot}/`)) throw stop;
  });
  try {
    expect(() => runMigrations(db)).toThrow(stop);
  } finally {
    log.mockRestore();
  }
  return db;
}

function checkCache(db: Database.Database) {
  db.prepare(
    `INSERT INTO place_details_cache (place_id, lang, expanded, payload_json, fetched_at)
    VALUES ('same-id', 'zh', 0, '{"name":"Google"}', 123)`,
  ).run();
  db.prepare(
    `INSERT INTO place_details_cache (provider, place_id, lang, expanded, payload_json, fetched_at)
    VALUES ('amap', 'same-id', 'zh', 0, '{"name":"Amap"}', 456)`,
  ).run();
  expect(
    db.prepare('SELECT provider FROM place_details_cache WHERE place_id = ? ORDER BY provider').all('same-id'),
  ).toEqual([{ provider: 'amap' }, { provider: 'google' }]);
}

describe('v4.3.0 migration bridge', () => {
  it('migrates fresh databases and accepts upstream and provider-scoped cache writes', () => {
    const db = new Database(':memory:');
    try {
      createTables(db);
      runMigrations(db);
      checkCache(db);
      const version = db.prepare('SELECT version FROM schema_version').get();
      runMigrations(db);
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual(version);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('replays upstream 176 after Chinese 176 and preserves existing provider cache rows', () => {
    const db = databaseBefore(176);
    try {
      // The shipped Chinese 176 adds these identities and widens the cache PK.
      for (const table of ['places', 'collection_places']) {
        for (const column of ['geo_provider', 'provider_place_id']) {
          if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
          }
        }
      }
      db.exec(`DROP TABLE place_details_cache;
        CREATE TABLE place_details_cache (
          provider TEXT NOT NULL, place_id TEXT NOT NULL, lang TEXT NOT NULL DEFAULT '',
          expanded INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL,
          PRIMARY KEY (provider, place_id, lang, expanded));
        INSERT INTO place_details_cache VALUES ('amap', 'saved', 'zh', 1, '{"saved":true}', 789);
        UPDATE schema_version SET version = 176;
        INSERT INTO users (id, username, email, password_hash) VALUES (1, 'fixture', 'fixture@example.test', 'unused');
        INSERT INTO trips (id, user_id, title) VALUES (1, 1, 'Existing trip');
        INSERT INTO places (trip_id, name, geo_provider, provider_place_id, lat, lng)
          VALUES (1, 'Existing Amap place', 'amap', 'B123', 31.2, 121.5);`);
      runMigrations(db);
      expect(
        db.prepare("SELECT name FROM pragma_table_info('vacay_entries') WHERE name = 'fraction'").get(),
      ).toBeTruthy();
      expect(
        db
          .prepare(
            "SELECT payload_json, fetched_at FROM place_details_cache WHERE provider = 'amap' AND place_id = 'saved'",
          )
          .get(),
      ).toEqual({ payload_json: '{"saved":true}', fetched_at: 789 });
      expect(db.prepare('SELECT name, geo_provider, provider_place_id, lat, lng FROM places').all()).toEqual([
        { name: 'Existing Amap place', geo_provider: 'amap', provider_place_id: 'B123', lat: 31.2, lng: 121.5 },
      ]);
      checkCache(db);
      runMigrations(db);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('rolls back schema changes together with a failed version write and can retry', () => {
    const db = databaseBefore(176);
    db.exec(`CREATE TRIGGER reject_version BEFORE UPDATE ON schema_version
      WHEN NEW.version = 176 BEGIN SELECT RAISE(ABORT, 'simulated version failure'); END;`);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('migration stopped');
    });
    try {
      expect(() => runMigrations(db)).toThrow('migration stopped');
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 175 });
      expect(
        db.prepare("SELECT 1 FROM pragma_table_info('vacay_entries') WHERE name = 'fraction'").get(),
      ).toBeUndefined();
      db.exec('DROP TRIGGER reject_version');
      runMigrations(db);
      checkCache(db);
    } finally {
      exit.mockRestore();
      db.close();
    }
  });

  it('upgrades upstream 241 and preserves its Google cache', () => {
    const db = databaseBefore(242);
    try {
      db.prepare(
        `INSERT INTO place_details_cache (place_id, lang, expanded, payload_json, fetched_at)
        VALUES ('saved-google', 'en', 1, '{}', 100)`,
      ).run();
      runMigrations(db);
      expect(
        db.prepare("SELECT provider, fetched_at FROM place_details_cache WHERE place_id = 'saved-google'").get(),
      ).toEqual({ provider: 'google', fetched_at: 100 });
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 242 });
      checkCache(db);
    } finally {
      db.close();
    }
  });

  it('continues upstream 176 without replaying its slot', () => {
    const db = databaseBefore(177);
    const log = vi.spyOn(console, 'log');
    try {
      runMigrations(db);
      expect(log.mock.calls.some(([message]) => String(message).startsWith('[DB] Running migration 176/'))).toBe(false);
      checkCache(db);
    } finally {
      log.mockRestore();
      db.close();
    }
  });
});
