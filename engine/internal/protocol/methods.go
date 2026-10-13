package protocol

import "reflect"

// None stands for a method without params or a result.
type None struct{}

type Request[P, R any] struct{ Name Method }
type Topic[P, D any] struct{ Name Method }

type MethodKind string

const (
	MethodKindRequest MethodKind = "request"
	MethodKindTopic   MethodKind = "topic"
)

// MethodDefinition describes one declared request or subscription topic.
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

func DeclareRequest[P, R any](name Method) Request[P, R] {
	declare[P, R](name, MethodKindRequest)
	return Request[P, R]{Name: name}
}

func DeclareTopic[P, D any](name Method) Topic[P, D] {
	declare[P, D](name, MethodKindTopic)
	return Topic[P, D]{Name: name}
}

// Methods returns the methods in declaration order.
func Methods() []MethodDefinition { return append([]MethodDefinition(nil), methods...) }

var (
	RequestClustersList = DeclareRequest[None, []Cluster]("clusters.list")
	RequestSettingsPut  = DeclareRequest[Setting, None]("settings.put")

	TopicClusterStatus  = DeclareTopic[ClusterParams, ClusterStatus]("cluster.status")
	TopicClusterTypes   = DeclareTopic[ClusterParams, []ResourceType]("cluster.types")
	TopicResourcesQuery = DeclareTopic[QueryParams, QueryResult]("resources.query")
	TopicResourcesFind  = DeclareTopic[FindParams, FindResult]("resources.find")
	TopicResourceGet    = DeclareTopic[ResourceRef, ResourceData]("resource.get")
	TopicSettingsWatch  = DeclareTopic[SettingKey, Setting]("settings.watch")
)
