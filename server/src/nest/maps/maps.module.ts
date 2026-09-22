import { AmapModule } from '../amap/amap.module';
import { Module } from '@nestjs/common';
import { MapsController } from './maps.controller';
import { MapsService } from './maps.service';

/** Maps / geo domain (L3 leaf module). Registered in AppModule. */
@Module({
  imports: [AmapModule],
  controllers: [MapsController],
  providers: [MapsService],
})
export class MapsModule {}
