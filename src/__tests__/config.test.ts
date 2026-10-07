import { resolveDevFlags, resolveReleaseChannel } from '../config';

describe('development flags', () => {
  const base = { isDev: false, appEnv: undefined, hooksFlag: undefined, panelFlag: undefined };

  it('are off by default in non-dev builds', () => {
    expect(resolveDevFlags(base)).toEqual({ hooks: false, panel: false });
  });

  it('never show the panel without the explicit panel flag, even in dev', () => {
    expect(resolveDevFlags({ ...base, isDev: true })).toEqual({ hooks: true, panel: false });
    expect(resolveDevFlags({ ...base, isDev: true, panelFlag: '1' })).toEqual({ hooks: true, panel: true });
  });

  it('are forced off in production regardless of other flags', () => {
    expect(
      resolveDevFlags({ isDev: true, appEnv: 'production', hooksFlag: '1', panelFlag: '1' }),
    ).toEqual({ hooks: false, panel: false });
  });
});

describe('release channel', () => {
  it('is staging only for a release build that says so; production otherwise; development outside release builds', () => {
    expect(resolveReleaseChannel({ appEnv: 'production', channel: 'staging' })).toBe('staging');
    expect(resolveReleaseChannel({ appEnv: 'production', channel: undefined })).toBe('production');
    expect(resolveReleaseChannel({ appEnv: 'production', channel: 'anything' })).toBe('production');
    expect(resolveReleaseChannel({ appEnv: 'development', channel: 'staging' })).toBe('development');
    expect(resolveReleaseChannel({ appEnv: undefined, channel: undefined })).toBe('development');
  });
});
