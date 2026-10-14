# Recorded Exec Sessions

`recordings/` holds what real programs printed in Exec Sessions on the e2e
k3d cluster (k3s v1.35.5, containerd 2.2.3), recorded on 2026-10-14 through
client-go v0.37.1's executor, the way the Engine runs a session. The tests of
what a window is sent when it attaches read them, in Go and, with xterm.js, in
TypeScript. `docs/plans/exec-resume.md` has what was measured with them.

Each file is JSON Lines. Every line has `t`, milliseconds since the session
started, and one of:

- `o`: output, base64.
- `r`: a terminal size the session was given, as `[cols, rows]`.
- `m`: a mark, naming the moment for a test.

The marks are `painted` (the program has drawn its screen), `before-same`,
`after-same` (after a resize to the size the session already had),
`after-shrink` (one row fewer), `after-restore` (the first size again),
`after-nudge` (both of those sent together), and `left` (the program has
exited to its shell).

| Recording               | Container | What runs                                          |
| ----------------------- | --------- | -------------------------------------------------- |
| `busybox-vi`            | busybox   | `vi`, then 1,600 cursor moves that paint nothing   |
| `busybox-less`          | busybox   | `less`, 30 lines down                              |
| `busybox-top`           | busybox   | `top -d 1`                                         |
| `busybox-midline`       | busybox   | `ash` with a command typed and not entered         |
| `busybox-progress`      | busybox   | a progress bar that rewrites its line 400 times    |
| `busybox-flood-midline` | busybox   | 20,000 lines, then a command typed and not entered |
| `alpine-vim`            | alpine    | `vim`, with the same cursor moves                  |
| `alpine-less`           | alpine    | GNU `less`                                         |
| `alpine-top`            | alpine    | procps `top -d 1`                                  |
| `alpine-htop`           | alpine    | `htop`                                             |
| `alpine-midline`        | alpine    | `bash` with a command typed and not entered        |
| `alpine-progress`       | alpine    | the progress bar, in `bash`                        |
| `alpine-flood-midline`  | alpine    | the 20,000 lines, in `bash`                        |

## Recording again

`record/` is the program that made them. It is under `testdata` so that it is
not built with the Engine. It needs two Pods in the e2e cluster:

```sh
export KUBECONFIG=.data/e2e/kubeconfig
kubectl create namespace exec-resume-probe
kubectl -n exec-resume-probe run bb --image=busybox:1.36 -- sh -c 'sleep 36000'
kubectl -n exec-resume-probe run full --image=alpine:3.20 -- sh -c \
  'apk add --no-cache bash vim less procps htop ncurses; sleep 36000'
kubectl -n exec-resume-probe wait --for=condition=Ready pod/bb pod/full
cd engine
go run ./internal/execsession/testdata/record \
  -kubeconfig ../.data/e2e/kubeconfig -out internal/execsession/testdata/recordings
kubectl delete namespace exec-resume-probe
```

A recording differs from run to run in its timing and in what `top` and
`htop` show, so the golden files made from the recordings change with them.
