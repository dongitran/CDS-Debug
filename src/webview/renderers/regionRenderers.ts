/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getRegionRenderersScript(): string {
  return `
    function hasReadyTopology() {
      return !!state.cfTopology
        && state.cfTopology.ready
        && Array.isArray(state.cfTopology.accounts)
        && state.cfTopology.accounts.length > 0;
    }

    function filterTopologyAccounts(accounts, query) {
      const q = String(query || '').trim().toLowerCase();
      if (q.length === 0) return accounts.slice(0, 50);
      const matches = [];
      for (const account of accounts) {
        const haystack = (
          account.orgName + ' ' + account.regionKey + ' ' + account.regionLabel
        ).toLowerCase();
        if (haystack.indexOf(q) !== -1) matches.push(account);
        if (matches.length >= 50) break;
      }
      return matches;
    }

    function filterRegions(query) {
      const q = String(query || '').trim().toLowerCase();
      if (q.length === 0) return CF_REGIONS;
      return CF_REGIONS.filter(region => {
        const haystack = (
          region.code + ' ' + region.name + ' ' + region.label + ' ' + region.apiEndpoint
        ).toLowerCase();
        return haystack.indexOf(q) !== -1;
      });
    }

    function findTopologyAccount(regionKey, orgName) {
      const accounts = (state.cfTopology && state.cfTopology.accounts) || [];
      for (const account of accounts) {
        if (account.regionKey === regionKey && account.orgName === orgName) return account;
      }
      return null;
    }

    function isSelectedTopologyOrg(account) {
      return !!state.selectedTopologyOrg
        && state.selectedTopologyOrg.regionKey === account.regionKey
        && state.selectedTopologyOrg.orgName === account.orgName;
    }

    function renderSearchField(inputId, value, placeholder, label) {
      return \`
        <label class="sr-only" for="\${escape(inputId)}">\${escape(label)}</label>
        <div class="search-input-wrap">
          <span class="search-input-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" focusable="false">
              <path d="M6.75 2.25a4.5 4.5 0 0 1 3.56 7.25l3.1 3.1a.57.57 0 0 1-.81.81l-3.1-3.1a4.5 4.5 0 1 1-2.75-8.06Zm0 1.15a3.35 3.35 0 1 0 0 6.7 3.35 3.35 0 0 0 0-6.7Z"></path>
            </svg>
          </span>
          <input class="input search-input" id="\${escape(inputId)}" type="search"
            placeholder="\${escape(placeholder)}"
            value="\${escape(value || '')}"
            autocomplete="off" spellcheck="false" />
        </div>
      \`;
    }

    function renderOrgSearchRows(filtered) {
      const rows = filtered.map(account => {
        const spaceCount = Array.isArray(account.spaces) ? account.spaces.length : 0;
        const meta = account.regionKey + ' · ' + spaceCount + ' space' + (spaceCount === 1 ? '' : 's');
        const selected = isSelectedTopologyOrg(account);
        return \`
          <button class="org-search-row \${selected ? 'selected' : ''}" type="button"
               data-org-search-region="\${escape(account.regionKey)}"
               data-org-search-org="\${escape(account.orgName)}"
               aria-pressed="\${selected ? 'true' : 'false'}"
               title="\${escape(account.orgName)} — \${escape(account.regionLabel)}">
            <span class="org-search-org">\${escape(account.orgName)}</span>
            <span class="org-search-meta">\${escape(meta)}</span>
          </button>
        \`;
      }).join('');
      return filtered.length === 0
        ? \`<div class="org-search-results empty">No org matches "\${escape(state.orgSearchQuery || '')}"</div>\`
        : \`<div class="org-search-results">\${rows}</div>\`;
    }

    function renderOrgSearchPanel() {
      const topology = state.cfTopology || { ready: false, accounts: [] };
      const filtered = filterTopologyAccounts(topology.accounts || [], state.orgSearchQuery);
      const totalLabel = topology.accounts.length === 1
        ? '1 org synced across all regions'
        : topology.accounts.length + ' orgs synced across all regions';
      return \`
        <div class="section-label">Search org (across regions)</div>
        <div class="org-search-block">
          \${renderSearchField('org-search-input', state.orgSearchQuery, 'Type to search orgs in any region...', 'Search orgs across regions')}
          \${renderOrgSearchRows(filtered)}
          <div class="radio-desc">\${escape(totalLabel)}</div>
        </div>
      \`;
    }

    function renderRegionCards() {
      const filteredRegions = filterRegions(state.regionSearchQuery);
      const regionCards = filteredRegions.map(r => \`
        <label class="region-card \${!state.useCustomEndpoint && state.selectedRegion === r.code ? 'selected' : ''}">
          <input type="radio" name="cf-region" value="\${escape(r.code)}"
            \${!state.useCustomEndpoint && state.selectedRegion === r.code ? 'checked' : ''} />
          <span class="region-card-content">
            <span class="region-main">
              <span class="region-code">\${escape(r.code)}</span>
              <span class="region-name">\${escape(r.name)}</span>
            </span>
            <span class="region-endpoint">\${escape(r.apiEndpoint)}</span>
          </span>
        </label>
      \`).join('');

      if (!regionCards) {
        return \`<div class="region-list-empty">No regions match "\${escape(state.regionSearchQuery || '')}"</div>\`;
      }
      return regionCards;
    }

    function renderRegionPickerPanel(includeSearch) {
      if (state.useCustomEndpoint) return renderCustomEndpointPanel();

      const searchHtml = includeSearch ? \`
        <div class="region-search-block">
          \${renderSearchField('region-search-input', state.regionSearchQuery, 'Type to filter regions...', 'Search regions')}
        </div>
      \` : '';

      return \`
        <div class="section-label">Select Region</div>
        \${searchHtml}
        <div class="region-list" role="radiogroup" aria-label="Cloud Foundry regions">
          \${renderRegionCards()}
        </div>
        <div class="radio-desc region-current-endpoint">
          Endpoint: <code>\${escape(regionToEndpoint(state.selectedRegion))}</code>
        </div>
      \`;
    }

    function renderCustomEndpointPanel() {
      return \`
        <div class="custom-endpoint-panel">
          <div class="section-label">Custom Endpoint</div>
          <label class="sr-only" for="api-endpoint-custom">Custom CF API endpoint</label>
          <input class="input custom-endpoint-input" id="api-endpoint-custom" type="url"
            placeholder="https://api.cf.<region>.<domain>"
            value="\${escape(state.apiEndpoint)}"
            autocomplete="off" spellcheck="false" />
          <div class="radio-desc custom-endpoint-hint">Enter your full CF API URL</div>
          <button class="btn btn-secondary custom-endpoint-back" id="btn-region-list" type="button">
            Back to region list
          </button>
        </div>
      \`;
    }

    function renderRegionTabs() {
      const mode = state.regionSelectorMode === 'region' ? 'region' : 'org';
      const regionLabel = state.useCustomEndpoint ? 'Region (Custom)' : 'Region';
      return \`
        <div class="region-selector-tabs" role="tablist" aria-label="Cloud Foundry selector">
          <button class="selector-tab \${mode === 'org' ? 'active' : ''}" type="button"
            role="tab" aria-selected="\${mode === 'org' ? 'true' : 'false'}"
            data-region-selector-mode="org">Org</button>
          <button class="selector-tab \${mode === 'region' ? 'active' : ''}" type="button"
            role="tab" aria-selected="\${mode === 'region' ? 'true' : 'false'}"
            data-region-selector-mode="region">\${regionLabel}</button>
        </div>
      \`;
    }

    function renderRegionFooter(topologyReady) {
      const showCustomButton = (!topologyReady || state.regionSelectorMode === 'region') && !state.useCustomEndpoint;
      const customButton = showCustomButton
        ? '<button class="btn btn-secondary" id="btn-custom-endpoint" type="button">Custom endpoint</button>'
        : '';
      let loginButton;
      if (!topologyReady || state.regionSelectorMode === 'region') {
        loginButton = '<button class="btn" id="btn-login">Login to Cloud Foundry</button>';
      } else {
        const disabled = findSelectedTopologyAccount() ? '' : 'disabled';
        const label = disabled ? 'Select an Org to Continue' : 'Continue with Selected Org';
        loginButton = \`<button class="btn" id="btn-login" \${disabled}>\${label}</button>\`;
      }
      return \`<div class="region-actions">\${customButton}\${loginButton}</div>\`;
    }

    function findSelectedTopologyAccount() {
      if (!state.selectedTopologyOrg) return null;
      return findTopologyAccount(state.selectedTopologyOrg.regionKey, state.selectedTopologyOrg.orgName);
    }

    function renderRegion() {
      const topologyReady = hasReadyTopology();
      const activePanel = state.regionSelectorMode === 'region'
        ? renderRegionPickerPanel(true)
        : renderOrgSearchPanel();

      return \`
        <div class="region-layout \${topologyReady ? 'topology-ready' : ''}">
          <div class="step-header">
            <span class="step-badge">1/3</span>
            <span class="step-title">CF Region / Org</span>
          </div>
          \${state.error ? \`<div class="error-box">\${escape(state.error)}</div>\` : ''}
          \${topologyReady ? renderRegionTabs() : ''}
          <div class="region-tab-panel" role="tabpanel">
            \${topologyReady ? activePanel : renderRegionPickerPanel(true)}
          </div>
          \${renderRegionFooter(topologyReady)}
        </div>
      \`;
    }
  `;
}
