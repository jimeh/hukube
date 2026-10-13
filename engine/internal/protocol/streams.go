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
)

// StreamClientMessage is a text message from a client on a stream socket.
type StreamClientMessage struct {
	Type   StreamClientType `json:"type"`
	Method Method           `json:"method,omitempty"`
	Params json.RawMessage  `json:"params,omitempty" tstype:"unknown"`
	// Bytes is the total length of the binary frames the client has consumed
	// since the stream opened.
	Bytes uint64 `json:"bytes,omitempty"`
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
)

// StreamServerMessage is a text message from the Engine on a stream socket.
type StreamServerMessage struct {
	Type  StreamServerType `json:"type"`
	Hello *Hello           `json:"hello,omitempty"`
	Event any              `json:"event,omitempty" tstype:"unknown"`
	Gap   *StreamGap       `json:"gap,omitempty"`
	End   *StreamEnd       `json:"end,omitempty"`
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
	// StreamEndReasonError means the stream failed, with Error saying how.
	StreamEndReasonError StreamEndReason = "error"
)

// StreamEnd is the Engine's last message on a stream. A socket that closes
// without one was lost.
type StreamEnd struct {
	Reason StreamEndReason `json:"reason"`
	Error  *ErrorDetail    `json:"error,omitempty"`
}

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
	Sources    []LogSource    `json:"sources"`
	Containers []LogContainer `json:"containers"`
	// Pods counts the Pods the Resource owns, and Followed those being read.
	Pods     int `json:"pods"`
	Followed int `json:"followed"`
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
