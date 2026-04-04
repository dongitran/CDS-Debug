# health-svc — SAP CAP Sample Service

Minimal SAP CAP service used to demo and test the **CDS Debug** extension.

## Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `http://localhost:4004/health/ping` | Returns `"pong"` |
| GET | `http://localhost:4004/health/status` | Returns service status, uptime, and version |

## Running Locally

```bash
npm install
npm run watch   # cds watch — hot reload
```

After starting the service, open:
- `http://localhost:4004` — CDS welcome page
- `http://localhost:4004/health/ping` — ping endpoint
- `http://localhost:4004/health/status` — status endpoint

## Debugging with CDS Debug Extension

1. Open the CDS Debug extension in VS Code.
2. Select this folder as the root directory.
3. Run `npx cds watch --inspect=9229` in your terminal.
4. Attach the debugger using the automatically generated launch configuration.
