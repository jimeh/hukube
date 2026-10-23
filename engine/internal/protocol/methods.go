package protocol

import "reflect"

// None stands for a method without params or a result.
type None struct{}

// Request names a request with params P and result R.
type Request[P, R any] struct{ Name Method }

// Topic names a subscription topic with params P and data D.
type Topic[P, D any] struct{ Name Method }

// Stream names a stream with params P and events E.
type Stream[P, E any] struct{ Name Method }

// MethodKind distinguishes requests, subscription topics, and streams.
type MethodKind string

const (
	// MethodKindRequest identifies a request.
	MethodKindRequest MethodKind = "request"
	// MethodKindTopic identifies a subscription topic.
	MethodKindTopic MethodKind = "topic"
	// MethodKindStream identifies a stream, which has its own socket.
	MethodKindStream MethodKind = "stream"
)

// MethodDefinition describes one declared method.
type MethodDefinition struct {
	Name   Method
	Kind   MethodKind
	Params reflect.Type
	Result reflect.Type
}

var methods []MethodDefinition

func declare[P, R any](name Method, kind MethodKind) {
	for _, m := range methods {
		if m.Name == name {
			panic("protocol: duplicate method " + name)
		}
	}
	methods = append(methods, MethodDefinition{name, kind, reflect.TypeFor[P](), reflect.TypeFor[R]()})
}

// DeclareRequest records a request with params P and result R.
func DeclareRequest[P, R any](name Method) Request[P, R] {
	declare[P, R](name, MethodKindRequest)
	return Request[P, R]{Name: name}
}

// DeclareTopic records a subscription topic with params P and data D.
func DeclareTopic[P, D any](name Method) Topic[P, D] {
	declare[P, D](name, MethodKindTopic)
	return Topic[P, D]{Name: name}
}

// DeclareStream records a stream with params P and events E.
func DeclareStream[P, E any](name Method) Stream[P, E] {
	declare[P, E](name, MethodKindStream)
	return Stream[P, E]{Name: name}
}

// Methods returns the methods in declaration order.
func Methods() []MethodDefinition { return append([]MethodDefinition(nil), methods...) }

// This is the one place each method is declared. The Engine's handlers
// register against these values, and mise run gen generates the TypeScript method
// map from them.
var (
	StreamPodExec      = DeclareStream[ExecParams, ExecSync]("pod.exec")
	StreamResourceLogs = DeclareStream[LogStreamParams, LogStreamStatus]("resource.logs")

	RequestExecEnd        = DeclareRequest[ExecEndParams, None]("exec.end")
	RequestClustersList   = DeclareRequest[None, []Cluster]("clusters.list")
	RequestResourceAccess = DeclareRequest[ResourceRef, ResourceAccess]("resource.access")
	RequestResourceReview = DeclareRequest[ResourceEdit, EditReview]("resource.review")
	RequestResourceApply  = DeclareRequest[ResourceEdit, ApplyResult]("resource.apply")
	RequestResourceDelete = DeclareRequest[DeleteParams, None]("resource.delete")
	RequestSettingsPut    = DeclareRequest[SettingPut, None]("settings.put")

	TopicClusterStatus   = DeclareTopic[ClusterParams, ClusterStatus]("cluster.status")
	TopicClusterTypes    = DeclareTopic[ClusterParams, []ResourceType]("cluster.types")
	TopicResourcesQuery  = DeclareTopic[QueryParams, QueryResult]("resources.query")
	TopicResourcesFind   = DeclareTopic[FindParams, FindResult]("resources.find")
	TopicResourceGet     = DeclareTopic[ResourceRef, ResourceData]("resource.get")
	TopicResourceEvents  = DeclareTopic[ResourceEventsParams, ResourceEvents]("resource.events")
	TopicResourceRelated = DeclareTopic[RelatedParams, Related]("resource.related")
	TopicSettingsWatch   = DeclareTopic[SettingKey, Setting]("settings.watch")
)
