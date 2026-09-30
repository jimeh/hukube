# A Go Engine in its own process, with every UI as a client

All Kubernetes access lives in a standalone Go Engine process. The desktop app
and the browser are both clients of it over the same protocol, and the Engine
never assumes it runs next to the UI. This gives us crash isolation, lets the
frontend run in a plain browser against a real Engine during development, and
makes the web Host (ADR-0007) a deployment choice, not a port.

Go over Rust: Go is also memory-safe, and the Engine is I/O-bound, so Rust's
remaining advantages (no GC, lower memory, data-race freedom) matter little
here. Go gives us client-go, the reference Kubernetes client, plus the kubectl,
Helm, and kustomize libraries as importable packages. Rust has kube-rs but no
Helm SDK and trails client-go on protocol and auth edge cases.

## Consequences

- The Electron main process only supervises the Engine and manages windows. It
  does not proxy cluster traffic.
- TypeScript protocol types are generated from Go definitions so the two sides
  cannot drift silently.
- Client-go's typed informers are memory-heavy. The Engine uses dynamic and
  metadata informers feeding its own compact store (ADR-0003).
