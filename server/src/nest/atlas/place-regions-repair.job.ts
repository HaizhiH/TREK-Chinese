import { logInfo, logError } from '../audit/audit-log.logger';
import { DatabaseService } from '../database/database.service';
import { CronRegistrarService } from '../scheduling/cron-registrar.service';
import { AtlasService } from './atlas.service';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

/** The app_settings row that says the pass below has been through every cached region. */
export const PLACE_REGIONS_REPAIR_DONE_KEY = 'place_regions_repair_2527';

/**
 * One pass over place_regions on the first start after #2527 (see
 * AtlasService.repairStaleRegionCache).
 *
 * Not a cron: from this version on the trigger on places drops a row as soon as its
 * place moves, so once the rows cached before it are put right there is nothing left
 * to repair. app_settings remembers that the pass ran. A pass cut short by a restart
 * or an error simply runs again on the next start; a second run changes nothing the
 * first one wrote.
 *
 * In the background, like the other boot sweeps: the server does not wait for it.
 */
@Injectable()
export class PlaceRegionsRepairJob implements OnApplicationBootstrap {
  constructor(
    private readonly atlas: AtlasService,
    private readonly registrar: CronRegistrarService,
    private readonly db: DatabaseService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.registrar.isEnabled()) return;
    void this.runOnce();
  }

  async runOnce(): Promise<void> {
    try {
      if (this.db.get('SELECT 1 FROM app_settings WHERE key = ?', PLACE_REGIONS_REPAIR_DONE_KEY)) return;
      const { replaced, dropped } = await this.atlas.repairStaleRegionCache();
      this.db.run(
        'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
        PLACE_REGIONS_REPAIR_DONE_KEY,
        new Date().toISOString(),
      );
      if (replaced + dropped > 0) {
        logInfo(
          `Atlas region repair: ${replaced} place region(s) re-derived where the place is now, ${dropped} left for the next Atlas load`,
        );
      }
    } catch (err: unknown) {
      logError(`Atlas region repair: ${err instanceof Error ? err.message : err}`);
    }
  }
}
