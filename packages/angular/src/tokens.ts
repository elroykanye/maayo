import { InjectionToken } from '@angular/core';
import type { SyncEngine } from '@maayo/client';

export const SYNC_ENGINE = new InjectionToken<SyncEngine>('MAAYO_SYNC_ENGINE');
