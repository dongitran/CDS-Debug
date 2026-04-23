import { describe, expect, it } from 'vitest';

import { getPackageBrowserScriptContent } from '../../src/webview/packageBrowserContent';
import { getRendererScriptContent } from '../../src/webview/webviewRenderers';

describe('webview markup contracts', () => {
  it('keeps Package as the only active-session secondary action', () => {
    const rendererScript = getRendererScriptContent();

    expect(rendererScript).toContain('data-packages-app');
    expect(rendererScript).toContain('Package</button>');
    expect(rendererScript).not.toContain('Open App');
    expect(rendererScript).toContain('enableBreakpointSnapshotHandling');
  });

  it('keeps the package browser screen minimal', () => {
    const packageScript = getPackageBrowserScriptContent();

    expect(packageScript).not.toContain('<span class="step-title">Packages</span>');
    expect(packageScript).not.toContain('Browse loaded package sources for the current debug session and filter them before opening files.');
    expect(packageScript).not.toContain('packages-summary');
  });
});
