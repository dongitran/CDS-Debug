import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/core/cfEnvironment', () => ({
  createCfProcessEnv: vi.fn((overrides: NodeJS.ProcessEnv) => Promise.resolve({ ...overrides })),
}));
import { parseOrgs, parseSpaces, parseApps, parseAppRoutes } from '../../src/core/cfClient';

describe('parseAppRoutes', () => {
  it('parses the routes line from cf app output', () => {
    const stdout = [
      'Showing health and status for app my-srv in org demo / space app as user@example.com...',
      '',
      'name:              my-srv',
      'requested state:   started',
      'routes:            my-srv.cfapps.eu10.hana.ondemand.com, my-srv-alias.cfapps.eu10.hana.ondemand.com',
      'last uploaded:     Mon 01 Jun 10:00:00 +07 2026',
      'stack:             cflinuxfs4',
    ].join('\n');

    expect(parseAppRoutes(stdout)).toEqual([
      'my-srv.cfapps.eu10.hana.ondemand.com',
      'my-srv-alias.cfapps.eu10.hana.ondemand.com',
    ]);
  });

  it('returns empty array when the app has no routes', () => {
    expect(parseAppRoutes('name: my-srv\nroutes:\nstack: cflinuxfs4')).toEqual([]);
    expect(parseAppRoutes('name: my-srv\nstack: cflinuxfs4')).toEqual([]);
    expect(parseAppRoutes('')).toEqual([]);
  });

  it('ignores empty segments produced by trailing commas', () => {
    expect(parseAppRoutes('routes:   a.example.com, , b.example.com,')).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });
});

describe('parseOrgs', () => {
  it('parses standard cf orgs output', () => {
    const stdout = [
      'Getting orgs as user@example.com...',
      '',
      'name',
      'client-a-dev',
      'client-b-dev',
      'client-c-poc',
      '',
    ].join('\n');

    expect(parseOrgs(stdout)).toEqual(['client-a-dev', 'client-b-dev', 'client-c-poc']);
  });

  it('returns empty array when no name header found', () => {
    expect(parseOrgs('some unexpected output')).toEqual([]);
  });

  it('returns empty array for empty output', () => {
    expect(parseOrgs('')).toEqual([]);
  });

  it('filters out blank lines after header', () => {
    const stdout = 'name\norg-one\n\norg-two\n\n';
    expect(parseOrgs(stdout)).toEqual(['org-one', 'org-two']);
  });

  it('trims whitespace from org names', () => {
    const stdout = 'name\n  org-with-spaces  \n';
    expect(parseOrgs(stdout)).toEqual(['org-with-spaces']);
  });
});

describe('parseSpaces', () => {
  it('parses standard cf spaces output', () => {
    const stdout = [
      'Getting spaces in org demo-org as user@example.com...',
      '',
      'name',
      'app',
      'dev',
      '',
    ].join('\n');

    expect(parseSpaces(stdout)).toEqual(['app', 'dev']);
  });

  it('returns empty array when no name header found', () => {
    expect(parseSpaces('unexpected output')).toEqual([]);
  });

  it('trims whitespace and filters blank space names', () => {
    expect(parseSpaces('name\n  app  \n\n  dev\n')).toEqual(['app', 'dev']);
  });
});

describe('parseApps', () => {
  const sampleOutput = [
    'Getting apps in org test-org / space app as user@example.com...',
    '',
    'name                    requested state   processes   routes',
    'myapp-db-one            started           web:0/0     ',
    'myapp-svc-one           started           web:1/1     myapp-svc-one.cfapps.br10.hana.ondemand.com',
    'myapp-svc-two           stopped           web:0/1     myapp-svc-two.cfapps.br10.hana.ondemand.com',
    'myapp-db-two            started           web:0/0     ',
    '',
  ].join('\n');

  it('parses started apps correctly', () => {
    const apps = parseApps(sampleOutput);
    const started = apps.filter((a) => a.state === 'started');
    expect(started.map((a) => a.name)).toEqual([
      'myapp-svc-one',
    ]);
  });

  it('parses stopped apps correctly', () => {
    const apps = parseApps(sampleOutput);
    const stopped = apps.filter((a) => a.state === 'stopped');
    expect(stopped.map((a) => a.name)).toEqual(['myapp-svc-two']);
  });

  it('parses empty apps correctly', () => {
    const apps = parseApps(sampleOutput);
    const empty = apps.filter((a) => a.state === 'empty');
    expect(empty.map((a) => a.name)).toEqual([
      'myapp-db-one',
      'myapp-db-two',
    ]);
  });

  it('returns all apps with correct count', () => {
    const apps = parseApps(sampleOutput);
    expect(apps).toHaveLength(4);
  });

  it('preserves running and total instance counts from cf apps output', () => {
    const apps = parseApps(sampleOutput);

    expect(apps.find((a) => a.name === 'myapp-svc-one')).toMatchObject({
      runningInstances: 1,
      totalInstances: 1,
    });
    expect(apps.find((a) => a.name === 'myapp-svc-two')).toMatchObject({
      runningInstances: 0,
      totalInstances: 1,
    });
    expect(apps.find((a) => a.name === 'myapp-db-one')).toMatchObject({
      runningInstances: 0,
      totalInstances: 0,
    });
  });

  it('parses urls for apps that have routes', () => {
    const apps = parseApps(sampleOutput);
    const svcOne = apps.find((a) => a.name === 'myapp-svc-one');
    expect(svcOne?.urls).toEqual(['myapp-svc-one.cfapps.br10.hana.ondemand.com']);

    const svcTwo = apps.find((a) => a.name === 'myapp-svc-two');
    expect(svcTwo?.urls).toEqual(['myapp-svc-two.cfapps.br10.hana.ondemand.com']);
  });

  it('returns empty urls for apps with no routes', () => {
    const apps = parseApps(sampleOutput);
    const dbOne = apps.find((a) => a.name === 'myapp-db-one');
    expect(dbOne?.urls).toEqual([]);
    const dbTwo = apps.find((a) => a.name === 'myapp-db-two');
    expect(dbTwo?.urls).toEqual([]);
  });

  it('parses multiple comma-separated routes into urls array', () => {
    const output = [
      'name  requested state  processes  routes',
      'multi-route-app  started  web:1/1  app.cfapps.eu10.hana.ondemand.com,app2.cfapps.eu10.hana.ondemand.com',
    ].join('\n');
    const apps = parseApps(output);
    expect(apps[0]?.urls).toEqual([
      'app.cfapps.eu10.hana.ondemand.com',
      'app2.cfapps.eu10.hana.ondemand.com',
    ]);
  });

  it('returns empty array when no header found', () => {
    expect(parseApps('unexpected output format')).toEqual([]);
  });

  it('returns empty array for empty output', () => {
    expect(parseApps('')).toEqual([]);
  });

  it('handles app with no routes column', () => {
    const output = 'name  requested state  processes\nmy-app  started  web:1/1\n';
    const apps = parseApps(output);
    expect(apps[0]).toMatchObject({ name: 'my-app', state: 'started', urls: [] });
  });

  it('returns empty array when lines after header are blank', () => {
    const output = 'name  requested state  processes  routes\n\n\n';
    expect(parseApps(output)).toEqual([]);
  });

  it('handles multiple running processes correctly (CF v8 syntax)', () => {
    // Both web and worker have running instances
    const output1 = 'name  requested state  processes\nmy-app  started  web:1/1, worker:2/2\n';
    expect(parseApps(output1)[0]?.state).toBe('started');
    expect(parseApps(output1)[0]).toMatchObject({
      runningInstances: 3,
      totalInstances: 3,
      instanceProcessCount: 2,
    });

    // Only worker has running instances
    const output2 = 'name  requested state  processes\nmy-app  started  web:0/1, worker:1/1\n';
    expect(parseApps(output2)[0]?.state).toBe('started');
    expect(parseApps(output2)[0]).toMatchObject({
      runningInstances: 1,
      totalInstances: 2,
      instanceProcessCount: 2,
    });

    // Neither has running instances
    const output3 = 'name  requested state  processes\nmy-app  started  web:0/1, worker:0/2\n';
    expect(parseApps(output3)[0]?.state).toBe('empty');
    expect(parseApps(output3)[0]).toMatchObject({
      runningInstances: 0,
      totalInstances: 3,
      instanceProcessCount: 2,
    });
  });

  it('marks single named-process apps as safe to scale from aggregate badge counts', () => {
    const output = 'name  requested state  processes\nmy-app  started  web:2/2\n';

    expect(parseApps(output)[0]).toMatchObject({
      runningInstances: 2,
      totalInstances: 2,
      instanceProcessCount: 1,
    });
  });

  it('handles older CF v7 instance format correctly', () => {
    const output = 'name  requested state  instances\nmy-app  started  1/1\n';
    expect(parseApps(output)[0]?.state).toBe('started');
    expect(parseApps(output)[0]).toMatchObject({ runningInstances: 1, totalInstances: 1 });

    const output2 = 'name  requested state  instances\nmy-app  started  0/1\n';
    expect(parseApps(output2)[0]?.state).toBe('empty');
    expect(parseApps(output2)[0]).toMatchObject({ runningInstances: 0, totalInstances: 1 });

    const output3 = 'name  requested state  instances\nmy-app  started  0/0\n';
    expect(parseApps(output3)[0]?.state).toBe('empty');
    expect(parseApps(output3)[0]).toMatchObject({ runningInstances: 0, totalInstances: 0 });
  });

  it('defaults to empty when processes column has unexpected format but state is started', () => {
    const output = 'name  requested state  processes\nmy-app  started  unexpected_format\n';
    expect(parseApps(output)[0]?.state).toBe('empty');
  });

  it('defaults to stopped for unrecognized states', () => {
    const output = 'name  requested state  processes\nmy-app  crashed  web:0/1\n';
    expect(parseApps(output)[0]?.state).toBe('stopped');
  });
});
