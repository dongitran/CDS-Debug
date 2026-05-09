# Remote Inspector Cleanup Hardening

CDS Debug opens the Node inspector in a CF app by sending `SIGUSR1` and then attaching through `cf ssh -L <local-port>:localhost:9229`.

Stopping the VS Code debug session closes the local tunnel and lets the debug adapter disconnect, but Node does not expose a reliable external command that closes an already-open inspector listener from outside the process. The reliable full reset remains an app restart.

This release hardens the gap in layers:

- Warn after Stop that the remote inspector may remain open until restart.
- Offer an opt-in `cf restart <app>` after Stop.
- Send defensive `setBreakpoints([])` requests before stopping a managed session.
- Detect stale local `cf ssh` inspector tunnels on activation.
- Warn when local source contains committed `debugger;` statements.
- Send lightweight keepalive requests so half-open inspector sessions recover faster.
- Signal a likely main Node process by default instead of every Node process in the container.

The defaults avoid restarting apps automatically because a restart can clear in-memory state. Users who prefer full cleanup can enable `cdsDebug.autoRestartAppAfterStop`.
