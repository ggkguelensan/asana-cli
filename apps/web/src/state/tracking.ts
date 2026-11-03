import { atom } from 'jotai';
import type { TrackingStatus } from '@asana-cli/service-client';
export const trackingStatusAtom = atom<TrackingStatus|null>(null);
