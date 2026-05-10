import type { AppNode } from '@saptools/cf-sync';
import type { CfApp, CfAppState } from '../types/index';

export function toCachedAppState(app: AppNode): CfAppState {
  if (app.requestedState !== 'started') return 'stopped';
  return (app.runningInstances ?? 0) > 0 ? 'started' : 'empty';
}

export function toCachedApp(app: AppNode): CfApp {
  return {
    name: app.name,
    state: toCachedAppState(app),
    urls: [...(app.routes ?? [])],
  };
}
