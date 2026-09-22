import { ChinaRailService } from './china-rail.service';
import { Module } from '@nestjs/common';

@Module({ providers: [ChinaRailService], exports: [ChinaRailService] })
export class ChinaRailModule {}
