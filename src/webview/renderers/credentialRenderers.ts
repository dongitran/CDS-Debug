/**
 * Render functions for the CDS Debug Launcher webview.
 * Injected as raw JS into the single <script> block — must not use ES module syntax.
 * All backticks and ${ are escaped because this content lives inside a TS template literal.
 */
export function getCredentialRenderersScript(): string {
  return `
    // === CREDENTIAL SETUP SCREEN ===

    function renderSetupCredentials() {
      const isUpdate = state.credentialStatus.hasCredentials;
      const headerTitle = isUpdate ? 'Update Credentials' : 'Setup Credentials';
      const saveBtnLabel = state.isSavingCreds
        ? \`<span class="spinner" style="width:11px;height:11px;border-width:1.5px;margin-right:6px"></span>Saving\u2026\`
        : (isUpdate ? 'Update & Continue' : 'Save & Continue');

      const backBtn = isUpdate ? \`
        <div style="height:6px"></div>
        <button class="btn btn-secondary" id="btn-cancel-creds">&#8592; Back to Settings</button>
      \` : \`
        <div class="divider" style="margin:16px 0 10px"></div>
        <div class="cred-env-hint">
          Alternatively, set <code>SAP_EMAIL</code> and <code>SAP_PASSWORD</code><br>
          environment variables in your shell profile.
        </div>
      \`;

      return \`
        <div class="step-header">
          <span class="step-title">\${escape(headerTitle)}</span>
        </div>
        <div class="info-box">
          Enter your SAP BTP credentials. They are stored securely in your
          system keychain (macOS Keychain, GNOME Keyring, or Windows Credential Manager).
        </div>
        \${state.credError ? \`<div class="error-box">\${escape(state.credError)}</div>\` : ''}
        <div class="section-label">Email</div>
        <input class="input" id="cred-email" type="email"
          placeholder="your.name@company.com"
          autocomplete="username"
          value="\${escape(state.setupCredEmail)}" />
        <div class="section-label" style="margin-top:10px">Password</div>
        <div class="input-password-wrap">
          <input class="input" id="cred-password" type="password"
            placeholder="Password"
            autocomplete="current-password" />
          <button class="btn-toggle-visibility" id="btn-toggle-pwd" type="button"
            aria-label="Toggle password visibility">&#128065;</button>
        </div>
        <div style="height:12px"></div>
        <button class="btn" id="btn-save-creds" \${state.isSavingCreds ? 'disabled' : ''}>\${saveBtnLabel}</button>
        \${backBtn}
      \`;
    }

    function attachCredentialListeners() {
      const $ = id => document.getElementById(id);

      $('btn-toggle-pwd')?.addEventListener('click', function() {
        const inp = $('cred-password');
        if (inp) {
          inp.type = inp.type === 'password' ? 'text' : 'password';
          const btn = $('btn-toggle-pwd');
          if (btn) btn.innerHTML = inp.type === 'password' ? '&#128065;' : '&#128065;&#65038;';
        }
      });

      $('btn-save-creds')?.addEventListener('click', function() {
        const emailInput = $('cred-email');
        const passwordInput = $('cred-password');
        const email = (emailInput ? emailInput.value : '').trim();
        const password = passwordInput ? passwordInput.value : '';

        if (!email) {
          state.credError = 'Email is required.';
          render(); return;
        }
        if (!email.includes('@')) {
          state.credError = 'Please enter a valid email address.';
          render(); return;
        }
        if (!password) {
          state.credError = 'Password is required.';
          render(); return;
        }

        state.credError = null;
        state.isSavingCreds = true;
        render();
        vscode.postMessage({ type: 'SAVE_CREDENTIALS', payload: { email, password } });
      });

      $('btn-cancel-creds')?.addEventListener('click', function() {
        state.credError = null;
        state.isSavingCreds = false;
        state.screen = SCREENS.SETTINGS;
        render();
      });

      // Allow Enter key to submit from either input
      [$('cred-email'), $('cred-password')].forEach(function(inp) {
        if (!inp) return;
        inp.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            const saveBtn = $('btn-save-creds');
            if (saveBtn && !saveBtn.disabled) saveBtn.click();
          }
        });
      });
    }
  `;
}
