import { runMigrations } from '../../../src/db/migrations';
import { createTestDb } from '../../helpers/test-db';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// place_regions is Atlas's cache of the country and region a place resolved to.
// It is derived from the place's lat, lng and address, so a change to any of them
// has to take the row with it, whichever code path wrote the change (#2527).

// The trigger ships at schema version 245. Later migrations are appended after it,
// so the replay case rewinds to just before it; the steps after it are idempotent.
const PLACE_REGIONS_TRIGGER_VERSION = 245;

describe('place_regions follows the place it was resolved from (#2527)', () => {
  let db: Database.Database;
  let placeId: number;
  let otherPlaceId: number;

  const cached = (id: number) =>
    db.prepare('SELECT country_code, region_code FROM place_regions WHERE place_id = ?').get(id) as
      | { country_code: string; region_code: string }
      | undefined;

  beforeEach(() => {
    db = createTestDb();
    db.exec("INSERT INTO users (username, email, password_hash) VALUES ('traveller', 'traveller@example.test', 'x')");
    const userId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;
    const tripId = db.prepare("INSERT INTO trips (user_id, title) VALUES (?, 'Trip')").run(userId)
      .lastInsertRowid as number;
    const insertPlace = db.prepare('INSERT INTO places (trip_id, name, lat, lng, address) VALUES (?, ?, ?, ?, ?)');
    placeId = insertPlace.run(tripId, 'Hotel', 48.8566, 2.3522, 'Rue de Rivoli, Paris, France')
      .lastInsertRowid as number;
    otherPlaceId = insertPlace.run(tripId, 'Museum', 48.8606, 2.3376, 'Rue de Rivoli, Paris, France')
      .lastInsertRowid as number;
    const insertRegion = db.prepare(
      "INSERT INTO place_regions (place_id, country_code, region_code, region_name) VALUES (?, 'FR', 'FR-IDF', 'Ile-de-France')",
    );
    insertRegion.run(placeId);
    insertRegion.run(otherPlaceId);
  });

  afterEach(() => db?.close());

  it('drops the cached region when the coordinates move', () => {
    db.prepare('UPDATE places SET lat = ?, lng = ? WHERE id = ?').run(52.5163, 13.3777, placeId);

    expect(cached(placeId)).toBeUndefined();
    expect(cached(otherPlaceId)).toEqual({ country_code: 'FR', region_code: 'FR-IDF' });
  });

  it('drops it when only the latitude or only the longitude changes', () => {
    db.prepare('UPDATE places SET lat = ? WHERE id = ?').run(48.9, placeId);
    db.prepare('UPDATE places SET lng = ? WHERE id = ?').run(2.4, otherPlaceId);

    expect(cached(placeId)).toBeUndefined();
    expect(cached(otherPlaceId)).toBeUndefined();
  });

  it('drops it when the address changes, including one filled in where there was none', () => {
    db.prepare('UPDATE places SET address = ? WHERE id = ?').run('Pariser Platz, Berlin, Germany', placeId);
    db.prepare('UPDATE places SET address = NULL WHERE id = ?').run(otherPlaceId);
    db.prepare(
      "INSERT INTO place_regions (place_id, country_code, region_code, region_name) VALUES (?, 'FR', 'FR-IDF', 'Ile-de-France')",
    ).run(otherPlaceId);
    // The import backfill only ever fills an empty address.
    db.prepare('UPDATE places SET address = COALESCE(address, ?) WHERE id = ?').run('Paris, France', otherPlaceId);

    expect(cached(placeId)).toBeUndefined();
    expect(cached(otherPlaceId)).toBeUndefined();
  });

  it('drops it when the location is cleared', () => {
    db.prepare('UPDATE places SET lat = NULL, lng = NULL WHERE id = ?').run(placeId);

    expect(cached(placeId)).toBeUndefined();
  });

  it('keeps it when an edit writes the same location back', () => {
    // The place editor and update_place write every column, location included.
    db.prepare(
      "UPDATE places SET name = 'Hotel du Louvre', notes = 'late check-in', lat = ?, lng = ?, address = ? WHERE id = ?",
    ).run(48.8566, 2.3522, 'Rue de Rivoli, Paris, France', placeId);
    db.prepare("UPDATE places SET place_time = '09:00', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(otherPlaceId);

    expect(cached(placeId)).toEqual({ country_code: 'FR', region_code: 'FR-IDF' });
    expect(cached(otherPlaceId)).toEqual({ country_code: 'FR', region_code: 'FR-IDF' });
  });

  it('ships at its own schema version and replays without a second trigger', () => {
    const triggers = () =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'places' AND name = 'trg_place_regions_follow_place'",
        )
        .all();
    expect(triggers()).toHaveLength(1);

    db.exec('DROP TRIGGER trg_place_regions_follow_place');
    db.prepare('UPDATE schema_version SET version = ?').run(PLACE_REGIONS_TRIGGER_VERSION);
    runMigrations(db);
    expect(triggers()).toHaveLength(0);

    db.prepare('UPDATE schema_version SET version = ?').run(PLACE_REGIONS_TRIGGER_VERSION - 1);
    runMigrations(db);
    runMigrations(db);
    expect(triggers()).toHaveLength(1);

    db.prepare('UPDATE places SET lat = ? WHERE id = ?').run(52.5163, placeId);
    expect(cached(placeId)).toBeUndefined();
  });
});
