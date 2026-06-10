import { getStyles } from './webviewStyles';
import { getScript } from './webviewScript';

/** Generates the full HTML document for the CDS Debug Launcher webview. */
export function getWebviewContent(): string {
  const nonce = generateNonce();
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SAP CAP Debug Launcher</title>
  <style>${getStyles()}</style>
</head>
<body>
  <div id="app">
    <!-- Static fallback: replaced by the first render(). If the inline script never
         runs (webview load hiccup, CSP failure), the user sees this instead of a
         permanently blank panel. -->
    <div style="padding:16px;text-align:center;opacity:0.85">
      <div>Loading CDS Debug&hellip;</div>
      <div style="margin-top:8px;font-size:12px;opacity:0.8">
        If this message does not disappear, reload the window
        (Command Palette &rarr; &quot;Developer: Reload Window&quot;).
      </div>
    </div>
  </div>
  ${getScript(nonce)}
</body>
</html>`;
}

function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
