import { describe, it, expect } from 'vitest';
import { parseOrgs, parseApps } from '../../src/core/cfClient';

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
      'myapp-db-one',
      'myapp-svc-one',
      'myapp-db-two',
    ]);
  });

  it('parses stopped apps correctly', () => {
    const apps = parseApps(sampleOutput);
    const stopped = apps.filter((a) => a.state === 'stopped');
    expect(stopped.map((a) => a.name)).toEqual(['myapp-svc-two']);
  });

  it('returns all apps with correct count', () => {
    const apps = parseApps(sampleOutput);
    expect(apps).toHaveLength(4);
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
});
