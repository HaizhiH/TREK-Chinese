import { DatabaseModule } from '../database/database.module';
import { AmapConfigService } from './amap-config.service';
import { AmapProvider } from './amap.provider';
import { Module } from '@nestjs/common';

@Module({
  imports: [DatabaseModule],
  providers: [AmapConfigService, AmapProvider],
  exports: [AmapConfigService, AmapProvider],
})
export class AmapModule {}
