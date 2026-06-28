/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
import {
  getRegionRenderersScript,
  getLoginRenderersScript,
  getActiveSessionRenderersScript,
  getSnapshotRenderersScript,
  getAppListRenderersScript,
  getSettingsRenderersScript,
  getBranchPrepRenderersScript,
  getCredentialRenderersScript,
} from './renderers';

export function getRendererScriptContent(): string {
  return [
    getRegionRenderersScript(),
    getLoginRenderersScript(),
    getActiveSessionRenderersScript(),
    getSnapshotRenderersScript(),
    getAppListRenderersScript(),
    getSettingsRenderersScript(),
    getBranchPrepRenderersScript(),
    getCredentialRenderersScript(),
  ].join('\n');
}
