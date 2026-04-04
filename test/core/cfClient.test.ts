import { describe, it, expect } from 'vitest';
import { parseOrgs, parseApps } from '../../src/core/cfClient';

describe('parseOrgs', () => {
  it('parses standard cf orgs output', () => {
    const stdout = [
      'Getting orgs as user@example.com...',
      '',
      'name',
      'alcon-poc-client',
      'dole-dev-client',
      'single-dev-client',
      '',
    ].join('\n');

    expect(parseOrgs(stdout)).toEqual(['alcon-poc-client', 'dole-dev-client', 'single-dev-client']);
  });

  it('returns empty array when no name header found', () => {
    expect(parseOrgs('some unexpected output')).toEqual([]);
  });

  it('returns empty array for empty output', () => {
    expect(parseOrgs('')).toEqual([]);
  });

  it('filters out blank lines after header', () => {
    const stdout = 'name\nfoo\n\nbar\n\n';
    expect(parseOrgs(stdout)).toEqual(['foo', 'bar']);
  });

  it('trims whitespace from org names', () => {
    const stdout = 'name\n  org-with-spaces  \n';
    expect(parseOrgs(stdout)).toEqual(['org-with-spaces']);
  });
});

describe('parseApps', () => {
  const sampleOutput = [
    'Getting apps in org foo / space app as user@example.com...',
    '',
    'name                               requested state   processes   routes',
    'prefix-db-config                   started           web:0/0     ',
    'prefix-srv-config-main             started           web:1/1     foo-srv-config-main.cfapps.br10.hana.ondemand.com',
    'prefix-srv-config-admin            stopped           web:0/1     foo-srv-config-admin.cfapps.br10.hana.ondemand.com',
    'prefix-db-process                  started           web:0/0     ',
    '',
  ].join('\n');

  it('parses started apps correctly', () => {
    const apps = parseApps(sampleOutput);
    const started = apps.filter((a) => a.state === 'started');
    expect(started.map((a) => a.name)).toEqual([
      'prefix-db-config',
      'prefix-srv-config-main',
      'prefix-db-process',
    ]);
  });

  it('parses stopped apps correctly', () => {
    const apps = parseApps(sampleOutput);
    const stopped = apps.filter((a) => a.state === 'stopped');
    expect(stopped.map((a) => a.name)).toEqual(['prefix-srv-config-admin']);
  });

  it('returns all apps with correct count', () => {
    const apps = parseApps(sampleOutput);
    expect(apps).toHaveLength(4);
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
    expect(apps[0]).toMatchObject({ name: 'my-app', state: 'started' });
  });
});
