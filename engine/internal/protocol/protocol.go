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
	// Rev is the revision of subscription params, chosen by the client.
	Rev    uint64          `json:"rev,omitempty"`
	ID     uint64          `json:"id"`
	Type   ClientType      `json:"type"`
	Method Method          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty" tstype:"unknown"`
}

// ServerType identifies the kind of ServerMessage.
type ServerType string

const (
	// ServerTypeHello is the first message on a control socket.
	ServerTypeHello ServerType = "hello"
	// ServerTypeResult answers a request.
	ServerTypeResult ServerType = "result"
	// ServerTypeData carries the latest value of a subscription.
	ServerTypeData ServerType = "data"
	// ServerTypeError reports a failed request or subscription.
	ServerTypeError ServerType = "error"
)

// ServerMessage is sent from the Engine to a UI client.
type ServerMessage struct {
	// Rev is the revision of the params a subscription data or error answers.
	Rev   uint64       `json:"rev,omitempty"`
	Hello *Hello       `json:"hello,omitempty"`
	ID    uint64       `json:"id"`
	Type  ServerType   `json:"type"`
	Data  any          `json:"data,omitempty" tstype:"unknown"`
	Error *ErrorDetail `json:"error,omitempty"`
}

// Hello is the first message the Engine sends on a control socket.
type Hello struct {
	// Protocol is the Engine's protocol Hash.
	Protocol string `json:"protocol"`
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
	// ExprOpSelector matches when the Resource's labels satisfy the
	// Kubernetes label selector in Values[0], such as "app=web,tier!=db". It
	// takes no Field.
	ExprOpSelector ExprOp = "selector"
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
	// SortFieldColumn sorts by the cells of the Column named by Sort.Column.
	SortFieldColumn SortField = "column"
)

// Sort orders a query result.
type Sort struct {
	Field SortField `json:"field"`
	// Column names the Column to sort by when Field is SortFieldColumn. Rows
	// without a value for it sort last in both directions, and a name the
	// result has no Column for leaves the rows in name order.
	Column string `json:"column,omitempty"`
	Desc   bool   `json:"desc,omitempty"`
}

// QueryParams subscribes to one window of the Resources matching a Query.
// A nil Where matches every Resource.
type QueryParams struct {
	Cluster string `json:"cluster"`
	Where   *Expr  `json:"where,omitempty"`
	Sort    Sort   `json:"sort"`
	Offset  int    `json:"offset"`
	Limit   int    `json:"limit"`
	// Columns asks for the Columns of the one Resource Type the Query selects,
	// and for each Row's cells. A Query that can match any other number of
	// types is a bad request.
	Columns bool `json:"columns,omitempty"`
}

// Column describes one column of a Resource Type's list, as the Cluster
// defines it for `kubectl get`. The name and age columns are left out, because
// every Row already carries a name and a creation time.
type Column struct {
	Name string `json:"name"`
	// Type is the OpenAPI type the Cluster declares for the column's cells:
	// string, integer, number, boolean, or date. It is a hint, not a promise:
	// built-in types declare some columns of numbers as string. A date cell
	// holds a duration the Cluster rendered, such as "5m", not a timestamp.
	Type string `json:"type"`
	// Priority is 0 for the columns `kubectl get` shows by default, and higher
	// for the ones it only shows with `-o wide`.
	Priority int `json:"priority"`
}

// QueryResult is one window of a query's matching Resources.
type QueryResult struct {
	Total  int   `json:"total"`
	Offset int   `json:"offset"`
	Rows   []Row `json:"rows"`
	// Columns is absent when QueryParams.Columns is unset, and until the
	// Engine has fetched them.
	Columns []Column `json:"columns,omitempty"`
}

// Row summarizes one Resource in a query result.
type Row struct {
	UID       string    `json:"uid"`
	Type      TypeKey   `json:"type"`
	Namespace string    `json:"namespace,omitempty"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt" tstype:"string"`
	// Cells holds one value per QueryResult.Columns entry. It is absent while
	// the Engine has no cells for the Resource.
	Cells []any `json:"cells,omitempty" tstype:"unknown[]"`
}

// FindParams subscribes to the Resources, among those Where selects, whose
// names best match Text. Text holds space-separated words that must all
// match a name, case-insensitively: fuzzily, as in fzf, or as an exact
// substring when the word starts with "'". Text without words matches
// nothing.
type FindParams struct {
	Cluster string `json:"cluster"`
	Where   *Expr  `json:"where,omitempty"`
	Text    string `json:"text"`
	Limit   int    `json:"limit"`
}

// FindResult holds the best matches of a find, best first, and the number of
// matches in total.
type FindResult struct {
	Total int   `json:"total"`
	Rows  []Row `json:"rows"`
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
