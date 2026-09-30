// Package protocol defines the messages exchanged between UI clients and the
// Engine over the control socket. TypeScript types are generated from this
// package with tygo, so every exported type here is part of the wire contract.
package protocol

import (
	"encoding/json"
	"time"
)

// Subprotocol is the WebSocket subprotocol a client must offer on the
// control socket. The client also offers TokenSubprotocolPrefix followed by
// the Engine's token, because browsers cannot set headers on WebSockets.
const (
	Subprotocol            = "hukube.v1"
	TokenSubprotocolPrefix = "hukube.token."
)

// ClientType identifies what a ClientMessage asks the Engine to do.
type ClientType string

const (
	// ClientTypeRequest asks for a single response.
	ClientTypeRequest ClientType = "request"
	// ClientTypeSubscribe starts a subscription that emits data until cancelled.
	ClientTypeSubscribe ClientType = "subscribe"
	// ClientTypeUpdate replaces the params of an existing subscription, such as
	// when a list scrolls to a new window.
	ClientTypeUpdate ClientType = "update"
	// ClientTypeUnsubscribe cancels a subscription.
	ClientTypeUnsubscribe ClientType = "unsubscribe"
)

// ClientMessage is sent from a UI client to the Engine. ID is chosen by the
// client and correlates responses and subscription data.
type ClientMessage struct {
	ID     uint64          `json:"id"`
	Type   ClientType      `json:"type"`
	Method Method          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty" tstype:"unknown"`
}

// ServerType identifies the kind of ServerMessage.
type ServerType string

const (
	// ServerTypeResult answers a request.
	ServerTypeResult ServerType = "result"
	// ServerTypeData carries the latest value of a subscription.
	ServerTypeData ServerType = "data"
	// ServerTypeError reports a failed request or subscription.
	ServerTypeError ServerType = "error"
)

// ServerMessage is sent from the Engine to a UI client.
type ServerMessage struct {
	ID    uint64       `json:"id"`
	Type  ServerType   `json:"type"`
	Data  any          `json:"data,omitempty" tstype:"unknown"`
	Error *ErrorDetail `json:"error,omitempty"`
}

// ErrorCode classifies an ErrorDetail.
type ErrorCode string

const (
	ErrorCodeBadRequest ErrorCode = "bad_request"
	ErrorCodeNotFound   ErrorCode = "not_found"
	ErrorCodeForbidden  ErrorCode = "forbidden"
	ErrorCodeInternal   ErrorCode = "internal"
)

// ErrorDetail describes why a request or subscription failed.
type ErrorDetail struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

func (e *ErrorDetail) Error() string { return string(e.Code) + ": " + e.Message }

// Method names a request or subscription topic.
type Method string

const (
	// MethodClustersList returns []Cluster.
	MethodClustersList Method = "clusters.list"
	// MethodClusterStatus subscribes with ClusterParams to ClusterStatus.
	MethodClusterStatus Method = "cluster.status"
	// MethodClusterTypes subscribes with ClusterParams to []ResourceType.
	MethodClusterTypes Method = "cluster.types"
	// MethodResourcesQuery subscribes with QueryParams to QueryResult.
	MethodResourcesQuery Method = "resources.query"
	// MethodResourceGet subscribes with ResourceRef to ResourceData.
	MethodResourceGet Method = "resource.get"
	// MethodSettingsWatch subscribes with SettingKey to Setting.
	MethodSettingsWatch Method = "settings.watch"
	// MethodSettingsPut stores a Setting and returns nothing.
	MethodSettingsPut Method = "settings.put"
)

// Cluster is one kubeconfig context the Engine can connect to.
type Cluster struct {
	// ID is the kubeconfig context name.
	ID        string `json:"id"`
	Server    string `json:"server"`
	User      string `json:"user"`
	Namespace string `json:"namespace,omitempty"`
	// Current reports whether this is the kubeconfig's current context.
	Current bool `json:"current"`
}

// ClusterParams selects a Cluster.
type ClusterParams struct {
	Cluster string `json:"cluster"`
}

// ClusterPhase is the connection state of a Cluster.
type ClusterPhase string

const (
	ClusterPhaseConnecting ClusterPhase = "connecting"
	ClusterPhaseReady      ClusterPhase = "ready"
	ClusterPhaseFailed     ClusterPhase = "failed"
)

// ClusterStatus reports the Engine's connection to a Cluster.
type ClusterStatus struct {
	Phase         ClusterPhase `json:"phase"`
	Message       string       `json:"message,omitempty"`
	ServerVersion string       `json:"serverVersion,omitempty"`
}

// TypeKey identifies a Resource Type independently of API version, in
// kubectl's "resource.group" form, such as "deployments.apps". Core types
// have no group suffix, such as "pods".
type TypeKey string

// TypeState is the Engine's indexing state for a Resource Type.
type TypeState string

const (
	TypeStateSyncing   TypeState = "syncing"
	TypeStateReady     TypeState = "ready"
	TypeStateForbidden TypeState = "forbidden"
	TypeStateFailed    TypeState = "failed"
)

// ResourceType is a Resource Type served by a Cluster, with the number of
// Resources the Engine currently indexes for it.
type ResourceType struct {
	Key        TypeKey   `json:"key"`
	Group      string    `json:"group"`
	Version    string    `json:"version"`
	Resource   string    `json:"resource"`
	Kind       string    `json:"kind"`
	Namespaced bool      `json:"namespaced"`
	Verbs      []string  `json:"verbs"`
	ShortNames []string  `json:"shortNames,omitempty"`
	Categories []string  `json:"categories,omitempty"`
	State      TypeState `json:"state"`
	Count      int       `json:"count"`
}

// ExprOp is the operator of a query Expr.
type ExprOp string

const (
	ExprOpAnd ExprOp = "and"
	ExprOpOr  ExprOp = "or"
	ExprOpNot ExprOp = "not"
	// ExprOpIn matches when the field equals any of Values.
	ExprOpIn ExprOp = "in"
	// ExprOpContains matches when the field contains Values[0],
	// case-insensitively.
	ExprOpContains ExprOp = "contains"
)

// Field is a Resource attribute a query Expr can test.
type Field string

const (
	FieldType      Field = "type"
	FieldNamespace Field = "namespace"
	FieldName      Field = "name"
)

// Expr is a Query expression tree. Logical operators use Args; comparison
// operators use Field and Values.
type Expr struct {
	Op     ExprOp   `json:"op"`
	Field  Field    `json:"field,omitempty"`
	Values []string `json:"values,omitempty"`
	Args   []Expr   `json:"args,omitempty"`
}

// SortField is a column a query result can be sorted by.
type SortField string

const (
	SortFieldName      SortField = "name"
	SortFieldNamespace SortField = "namespace"
	SortFieldAge       SortField = "age"
)

// Sort orders a query result.
type Sort struct {
	Field SortField `json:"field"`
	Desc  bool      `json:"desc,omitempty"`
}

// QueryParams subscribes to one window of the Resources matching a Query.
// A nil Where matches every Resource.
type QueryParams struct {
	Cluster string `json:"cluster"`
	Where   *Expr  `json:"where,omitempty"`
	Sort    Sort   `json:"sort"`
	Offset  int    `json:"offset"`
	Limit   int    `json:"limit"`
}

// QueryResult is one window of a query's matching Resources.
type QueryResult struct {
	Total  int   `json:"total"`
	Offset int   `json:"offset"`
	Rows   []Row `json:"rows"`
}

// Row summarizes one Resource in a query result.
type Row struct {
	UID       string    `json:"uid"`
	Type      TypeKey   `json:"type"`
	Namespace string    `json:"namespace,omitempty"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt" tstype:"string"`
}

// ResourceRef addresses one Resource in a Cluster. Namespace is empty for
// cluster-scoped Resources.
type ResourceRef struct {
	Cluster   string  `json:"cluster"`
	Type      TypeKey `json:"type"`
	Namespace string  `json:"namespace,omitempty"`
	Name      string  `json:"name"`
}

// ResourceData is the latest full Manifest of a Resource, as JSON.
type ResourceData struct {
	Object  json.RawMessage `json:"object,omitempty" tstype:"{ [key: string]: unknown }"`
	Deleted bool            `json:"deleted,omitempty"`
}

// SettingKey selects a stored setting.
type SettingKey struct {
	Key string `json:"key"`
}

// Setting is a stored JSON value. A missing setting has a null Value.
type Setting struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value" tstype:"unknown"`
}
