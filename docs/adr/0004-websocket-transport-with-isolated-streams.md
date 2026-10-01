# WebSocket transport, with high-volume streams isolated from control traffic

UI clients talk to the Engine over WebSockets. One control socket per client
carries commands, Query subscriptions, and their patches. Each high-volume
stream, such as a Log Stream or an Exec Session, gets its own socket. This
means TCP head-of-line blocking or a stalled consumer on a noisy log tail
cannot delay control messages.

## Considered Options

- **One multiplexed socket with priority framing**: still suffers TCP
  head-of-line blocking, and we would have to build our own flow control.
- **gRPC or Connect**: browsers cannot do bidirectional streaming, which Exec
  Sessions need, so we would need WebSockets anyway.

## Consequences

- The Engine buffers each stream in a bounded buffer. When a client falls
  behind, it drops data and sends a gap marker; it never blocks.
- The Engine coalesces Query patches, sending the latest state at a bounded
  rate. Full fidelity lives in the Timeline, not in UI patches.
- The UI handles sockets and applies patches in a Web Worker so message
  bursts do not starve rendering.
- Browsers cap WebSockets per host, so the UI caps concurrent stream sockets,
  and multi-Pod Log Streams are merged by the Engine onto one socket.
