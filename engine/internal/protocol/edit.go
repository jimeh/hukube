package protocol

import "encoding/json"

// FieldPath addresses a field by its keys from the Manifest's root. A list is one field.
type FieldPath []string

// ResourceEdit is an edit of one Resource: one entry of a Changeset.
type ResourceEdit struct {
	Cluster   string  `json:"cluster"`
	Type      TypeKey `json:"type"`
	Namespace string  `json:"namespace,omitempty"`
	Name      string  `json:"name"`
	// UID is the Resource the edit was made to.
	UID string `json:"uid"`
	// Base is the Manifest the edit started from, and Manifest the edited one.
	Base     json.RawMessage `json:"base" tstype:"{ [key: string]: unknown }"`
	Manifest json.RawMessage `json:"manifest" tstype:"{ [key: string]: unknown }"`
}

// EditReview compares an edit with the Cluster and its dry-run answer.
type EditReview struct {
	// Before is the editable Manifest on the Cluster when the review was made.
	Before json.RawMessage `json:"before" tstype:"{ [key: string]: unknown }"`
	// Desired is Before with the edit applied. Apply takes these two as its edit.
	Desired json.RawMessage `json:"desired" tstype:"{ [key: string]: unknown }"`
	// After is what the Cluster would store, absent unless the dry run succeeded.
	After             json.RawMessage `json:"after,omitempty" tstype:"{ [key: string]: unknown }"`
	Edited            []FieldPath     `json:"edited"`
	ChangedOnCluster  []FieldPath     `json:"changedOnCluster"`
	Overlaps          []FieldPath     `json:"overlaps"`
	SetByCluster      []FieldPath     `json:"setByCluster"`
	Ignored           []FieldPath     `json:"ignored"`
	Warnings          []string        `json:"warnings"`
	Refusal           *ErrorDetail    `json:"refusal,omitempty"`
	DryRunUnsupported bool            `json:"dryRunUnsupported,omitempty"`
}

// ApplyResult reports the Resource's version after an apply.
type ApplyResult struct {
	ResourceVersion string   `json:"resourceVersion"`
	Unchanged       bool     `json:"unchanged,omitempty"`
	Warnings        []string `json:"warnings"`
}

// DeletePropagation decides how the API server deletes dependents.
type DeletePropagation string

const (
	DeletePropagationBackground DeletePropagation = "background"
	DeletePropagationForeground DeletePropagation = "foreground"
	DeletePropagationOrphan     DeletePropagation = "orphan"
)

// DeleteParams selects one incarnation of a Resource to delete.
type DeleteParams struct {
	Cluster     string            `json:"cluster"`
	Type        TypeKey           `json:"type"`
	Namespace   string            `json:"namespace,omitempty"`
	Name        string            `json:"name"`
	UID         string            `json:"uid"`
	Propagation DeletePropagation `json:"propagation"`
	// Immediate deletes a Pod without waiting for its containers to stop.
	Immediate bool `json:"immediate,omitempty"`
}

// ResourceAccess reports whether editing and deleting are permitted.
type ResourceAccess struct {
	Edit   Access `json:"edit"`
	Delete Access `json:"delete"`
}

// Access is denied only when the Engine knows the action would be refused.
type Access struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
}
