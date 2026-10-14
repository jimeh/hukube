package protocol

import "encoding/json"

// StreamSubprotocol is the WebSocket subprotocol a client must offer on a
// stream socket, with the token subprotocol the control socket uses.
const StreamSubprotocol = "hukube.stream.v1"

// The first byte of a binary frame on a stream socket is its channel, numbered
// as Kubernetes numbers the channels of an exec session. The rest of the frame
// is defined by the stream's method.
const (
	StreamChannelStdin  = 0
	StreamChannelStdout = 1
	StreamChannelStderr = 2
)

// A Log Stream's frame holds records after its channel byte. Each record is a
// source (2 bytes, a LogSource.ID), flags (1 byte), a time (8 bytes, signed
// Unix nanoseconds, 0 for a line without a timestamp), the content's length
// (4 bytes), and the content. Integers are big-endian.
const (
	// LogRecordHeaderSize is the size of a record without its content.
	LogRecordHeaderSize = 15
	// LogRecordFlagCut marks a line longer than the Engine keeps. The content
	// is its beginning.
	LogRecordFlagCut = 1
	// LogRecordFlagGap marks a place where lines of the source may be missing.
	// It has no content.
	LogRecordFlagGap = 2
	// LogRecordFlagExited marks the end of a container's run. The content is
	// the reason and exit code as text.
	LogRecordFlagExited = 4
)

// StreamClientType identifies a text message a client sends on a stream socket.
type StreamClientType string

const (
	// StreamClientTypeOpen names the stream's method and params. It is the
	// client's first message, sent once.
	StreamClientTypeOpen StreamClientType = "open"
	// StreamClientTypeAck reports how much data the client has consumed.
	StreamClientTypeAck StreamClientType = "ack"
	// StreamClientTypeResize gives an Exec Session's terminal size.
	StreamClientTypeResize StreamClientType = "resize"
)

// StreamClientMessage is a text message from a client on a stream socket.
type StreamClientMessage struct {
	Type   StreamClientType `json:"type"`
	Method Method           `json:"method,omitempty"`
	Params json.RawMessage  `json:"params,omitempty" tstype:"unknown"`
	// Bytes is the total length of the binary frames the client has consumed
	// since the stream opened.
	Bytes uint64 `json:"bytes,omitempty"`
	// Cols and Rows are the terminal size of a resize.
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

// StreamServerType identifies a text message the Engine sends on a stream socket.
type StreamServerType string

const (
	// StreamServerTypeHello is the first message on a stream socket.
	StreamServerTypeHello StreamServerType = "hello"
	// StreamServerTypeEvent carries a value typed by the stream's method.
	StreamServerTypeEvent StreamServerType = "event"
	// StreamServerTypeGap stands where the Engine dropped data.
	StreamServerTypeGap StreamServerType = "gap"
	// StreamServerTypeEnd is the last message of a stream.
	StreamServerTypeEnd StreamServerType = "end"
	// StreamServerTypeAck reports how much input the Engine has passed on.
	StreamServerTypeAck StreamServerType = "ack"
)

// StreamServerMessage is a text message from the Engine on a stream socket.
type StreamServerMessage struct {
	Type  StreamServerType `json:"type"`
	Hello *Hello           `json:"hello,omitempty"`
	Event any              `json:"event,omitempty" tstype:"unknown"`
	Gap   *StreamGap       `json:"gap,omitempty"`
	End   *StreamEnd       `json:"end,omitempty"`
	// Bytes is the total input the Engine has passed to the Cluster since the
	// stream opened, in an ack.
	Bytes uint64 `json:"bytes,omitempty"`
}

// StreamGap counts the data the Engine dropped because the client fell behind.
type StreamGap struct {
	Bytes uint64 `json:"bytes"`
	// Records counts what the frames held, as the method defines it: lines
	// for a Log Stream.
	Records uint64 `json:"records"`
}

// StreamEndReason says why a stream ended.
type StreamEndReason string

const (
	// StreamEndReasonComplete means the stream delivered everything it had.
	StreamEndReasonComplete StreamEndReason = "complete"
	// StreamEndReasonDeleted means the Resource the stream was about is gone.
	StreamEndReasonDeleted StreamEndReason = "deleted"
	// StreamEndReasonStopped means the container the stream ran in stopped.
	StreamEndReasonStopped StreamEndReason = "stopped"
	// StreamEndReasonError means the stream failed, with Error saying how.
	StreamEndReasonError StreamEndReason = "error"
	// StreamEndReasonDetached means the Exec Session carries on, and this
	// stream is not attached to it: another window is.
	StreamEndReasonDetached StreamEndReason = "detached"
)

// StreamEnd is the Engine's last message on a stream. A socket that closes
// without one was lost.
type StreamEnd struct {
	Reason StreamEndReason `json:"reason"`
	Error  *ErrorDetail    `json:"error,omitempty"`
	// ExitCode is the exit status of an Exec Session's process, with the
	// reason complete.
	ExitCode *int `json:"exitCode,omitempty"`
}

// LogStreamMaxPods is the most Pods one Log Stream reads.
const LogStreamMaxPods = 20

// LogStreamParams opens a Log Stream on a Pod, or on the Pods a Resource owns.
type LogStreamParams struct {
	Cluster   string  `json:"cluster"`
	Type      TypeKey `json:"type"`
	Namespace string  `json:"namespace,omitempty"`
	Name      string  `json:"name"`
	// UID is the incarnation to read. The stream ends when it is gone.
	UID string `json:"uid"`
	// Container names the container to read in every Pod. Empty reads all.
	Container string `json:"container,omitempty"`
	// Previous reads the previous run of each container and then ends.
	Previous bool `json:"previous,omitempty"`
	// Resume holds what the client already has, when it opens a stream again.
	Resume []LogCursor `json:"resume,omitempty"`
}

// LogCursor is the newest line a client holds from one container.
type LogCursor struct {
	PodUID    string `json:"podUid"`
	Container string `json:"container"`
	// Instance is the container ID the line came from.
	Instance string `json:"instance"`
	// Time is the line's timestamp in Unix nanoseconds, in decimal.
	Time string `json:"time"`
}

// LogStreamStatus is what a Log Stream reads right now.
type LogStreamStatus struct {
	// Ready reports that the stream has found its Resource and has sent the
	// history of the containers it reads, or waited a moment for it. Until
	// then, no lines and no sources mean "not yet", not "none".
	Ready      bool           `json:"ready"`
	Sources    []LogSource    `json:"sources"`
	Containers []LogContainer `json:"containers"`
	// Pods counts the Pods the Resource owns, and Followed those being read.
	Pods     int `json:"pods"`
	Followed int `json:"followed"`
	// Loaded counts the followed Pods whose containers are known. Sources
	// lists every container being read only once it equals Followed.
	Loaded int `json:"loaded"`
}

// LogContainerKind is the list of a Pod's spec that holds a container.
type LogContainerKind string

const (
	LogContainerKindContainer LogContainerKind = "container"
	LogContainerKindInit      LogContainerKind = "init"
	LogContainerKindEphemeral LogContainerKind = "ephemeral"
)

// LogContainer is a container name a Log Stream can be narrowed to.
type LogContainer struct {
	Name string           `json:"name"`
	Kind LogContainerKind `json:"kind"`
}

// LogSourceState is a container's state, from its Pod's status.
type LogSourceState string

const (
	LogSourceStateWaiting    LogSourceState = "waiting"
	LogSourceStateRunning    LogSourceState = "running"
	LogSourceStateTerminated LogSourceState = "terminated"
)

// LogSource is one container a Log Stream reads.
type LogSource struct {
	// ID is what a record's source field refers to.
	ID        int    `json:"id"`
	Pod       string `json:"pod"`
	PodUID    string `json:"podUid"`
	Container string `json:"container"`
	// Instance is the container ID being read, empty before the first run.
	Instance string         `json:"instance,omitempty"`
	State    LogSourceState `json:"state"`
	// Reason, Message, and ExitCode come from the container's status.
	Reason   string `json:"reason,omitempty"`
	Message  string `json:"message,omitempty"`
	ExitCode *int32 `json:"exitCode,omitempty"`
	// Previous reports that an earlier run exists.
	Previous bool `json:"previous,omitempty"`
	// Error is set while the container's logs cannot be read.
	Error string `json:"error,omitempty"`
}

// An Exec Session's input has its own acknowledged window, independent of
// its output's.
const (
	// ExecInputFrame is the most input one binary frame holds.
	ExecInputFrame = 32 << 10
	// ExecInputWindow is the most input a client sends beyond what the Engine
	// has acknowledged.
	ExecInputWindow = 256 << 10
)

// Reasons in the ErrorDetail of an Exec Session that ended with an error.
const (
	// ExecReasonNoShell means the container has no shell to run.
	ExecReasonNoShell = "NoShell"
	// ExecReasonConnectionLost means the session ran and then lost its
	// connection to the Cluster.
	ExecReasonConnectionLost = "ConnectionLost"
	// ExecReasonEngineStopped means the Engine shut down while the session ran.
	ExecReasonEngineStopped = "EngineStopped"
	// ExecReasonSessionGone means the Engine has no session with the ID a
	// stream tried to attach to.
	ExecReasonSessionGone = "SessionGone"
	// ExecReasonTooManySessions means the Engine runs as many sessions as it
	// allows, and did not start another.
	ExecReasonTooManySessions = "TooManySessions"
)

// ExecParams opens an Exec Session: a process with a TTY in a container.
type ExecParams struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	// UID is the Pod the session runs in. A Pod of the same name with another
	// UID is a different Pod.
	UID       string `json:"uid"`
	Container string `json:"container"`
	// Command replaces the default shell.
	Command []string `json:"command,omitempty"`
	// Session identifies the Exec Session. The client chooses it when the user
	// starts the session. Window identifies the window that attaches.
	Session string `json:"session"`
	Window  string `json:"window"`
	// Start asks for a new session when none has this ID. Without it the
	// stream only attaches.
	Start bool `json:"start,omitempty"`
	// Takeover attaches although another window is attached, which detaches
	// that window.
	Takeover bool `json:"takeover,omitempty"`
	// Resume is the position in the session's output that the client's
	// terminal has read to. It is absent when the terminal has read nothing
	// of this session.
	Resume *uint64 `json:"resume,omitempty"`
	// Cols and Rows are the terminal's size. Start requires them. A stream
	// that attaches gives them only when its terminal has been sized.
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

// ExecSync says where the output that follows it belongs in an Exec Session.
// It is the first message on a session's stream, and is sent again whenever
// the output that follows does not continue what the client has.
type ExecSync struct {
	// Offset is the position of the next byte of output.
	Offset uint64 `json:"offset"`
	// Reset is set when Offset is not the client's position. The client
	// clears its terminal before what follows.
	Reset bool `json:"reset,omitempty"`
	// Skipped counts the output the client will not receive.
	Skipped uint64 `json:"skipped,omitempty"`
	// Restore sets a reset terminal's modes to what they were at Offset.
	Restore string `json:"restore,omitempty"`
	// Replay counts the bytes that follow which the process had written when
	// this was sent. The client answers no query in them.
	Replay uint64 `json:"replay,omitempty"`
	// Cols and Rows are the session's terminal size.
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// ExecEndParams names an Exec Session to end, because its Tab closed.
type ExecEndParams struct {
	Cluster string `json:"cluster"`
	Session string `json:"session"`
}
