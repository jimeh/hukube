# An Exec Session runs a shell, counts as a mutation, and is told to exit

## What runs

A session runs one command with a TTY:

```sh
sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'
```

It gives `bash` where the image has it and `sh` otherwise, in one request.
A container without `sh` cannot run it, and the Tab says so with the
Cluster's own message.

This is the default. ADR-0025 lets the user choose another command, which
replaced "The user does not choose a command" here.

The Engine uses client-go's executor, WebSocket first and SPDY when the
upgrade fails, as `kubectl` does. The fallback tests for the upgrade error
from `k8s.io/streaming`. The helper of the same name in `k8s.io/apimachinery`
does not recognize the error client-go returns.

## A session is a mutation

A shell can change anything a write can. `hukube-engine --read-only`
(ADR-0020) refuses a session, and `resource.access` reports `exec` beside
`edit` and `delete`. Outside read-only mode, `exec` is a
`SelfSubjectAccessReview` for `create` on `pods/exec`, which the stream
checks again before it starts.

## Ending a session ends its shell, not what the shell is running

A Cluster does not clean up after an exec whose client went away. Measured
against k3s with containerd, a shell and its children were still running
after the client's connection was cancelled, and closing stdin did nothing
either, because the runtime keeps the TTY open.

So when a session is to end, the Engine hangs up: it writes
end-of-transmission to the session's stdin, waits a second for the
process to exit, and then drops the connection. A session is to end when its
Tab closes, when no window has been attached to it for 10 minutes, or when
the Engine shuts down (ADR-0026). A socket that closes is none of these. An
idle shell exits. A
command still running in the foreground keeps running, and the shell exits
when that command does. The Kubernetes Dashboard ends its sessions the same
way.

hukube says this where it matters: in the prompt before a live session's
Tab is closed or the desktop app quits. It does not claim a process is gone.

## Why a session ended

The executor reports an exit status and little else, so the Engine works out
the rest:

- An exit code other than 137 is the process's own.
- Exit code 137 means the process was killed, which is what the runtime does
  when a container stops. The Engine reads the Pod for up to 2 seconds and
  reports `deleted`, `stopped`, or the exit code.
- An error before any output is a failure to start. Its kind (not permitted,
  not found, no shell) is read from its text, because the executor returns
  no structured error. The text is always shown.
- An error after output is a lost connection to the Cluster.

## Considered Options

- **Try `bash`, then `sh`, each as its own exec,** as Headlamp and the
  Dashboard do. It works in an image with `bash` and no `sh`, which is rare,
  and it loses what the user typed while an attempt failed.
- **Let the user type a command.** Rejected at first, because few
  comparable tools do and a shell runs anything else. A container without a
  shell has no other way in, so ADR-0025 adds it.
- **Send an interrupt before end-of-transmission.** It would stop most
  running commands when the Tab closes, as a hang-up does over SSH. It would
  also stop a long job because a laptop slept or a network dropped, which
  `kubectl exec` does not do.
- **Type `exit` on close,** as Freelens does. It runs whatever is half-typed
  at the prompt with `exit` appended.
- **Track the process and kill it through a second exec.** It needs a shell,
  a known process ID, and a `kill` that reaches the whole session. It can be
  added later.
- **Treat a session as a read.** A user of `mise run dev:tailnet` would then
  have a root shell from a link meant to be read-only.

## Consequences

- A command a user leaves running in a closed session keeps running in the
  container until it ends or the container does.
- A user with `get` but not `create` on `pods/exec` is told a session is not
  permitted, although the WebSocket transport alone might let them in.
- Windows containers get the no-shell notice until the command is chosen by
  the Pod's operating system.
