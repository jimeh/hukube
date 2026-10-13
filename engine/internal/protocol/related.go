package protocol

import "time"

// RelatedParams selects the Resources related to one Resource.
type RelatedParams struct {
	Cluster   string  `json:"cluster"`
	Type      TypeKey `json:"type"`
	Namespace string  `json:"namespace,omitempty"`
	Name      string  `json:"name"`
	// Cells asks for the list cells of each related Resource (ADR-0010).
	Cells bool `json:"cells,omitempty"`
}

// Related is what the Engine knows to be related to a Resource.
type Related struct {
	// Found reports whether the index holds the Resource.
	Found    bool             `json:"found"`
	Sections []RelatedSection `json:"sections"`
	// Types holds the Columns of the types whose rows carry cells.
	Types []RelatedType `json:"types"`
	// Total counts the related Resources of every section.
	Total int `json:"total"`
}

// RelatedSection holds the Resources at the other end of one kind of
// Relationship, in one direction.
type RelatedSection struct {
	Relationship RelationshipKind `json:"relationship"` // "owns"
	// Direction is "in" for the Resources the Relationship comes from, such
	// as owners, and "out" for those it points to.
	Direction RelatedDirection `json:"direction"`
	Rows      []RelatedRow     `json:"rows"`
	Total     int              `json:"total"`
	Truncated bool             `json:"truncated,omitempty"`
}

type RelatedRow struct {
	Depth  int           `json:"depth"`
	Status RelatedStatus `json:"status"`
	Kind   string        `json:"kind"`
	// APIVersion is set for a reference that did not resolve.
	APIVersion string     `json:"apiVersion,omitempty"`
	Type       TypeKey    `json:"type,omitempty"`
	Namespace  string     `json:"namespace,omitempty"`
	Name       string     `json:"name,omitempty"`
	UID        string     `json:"uid,omitempty"`
	CreatedAt  *time.Time `json:"createdAt,omitempty" tstype:"string"`
	// Cells holds one value per Column of the row's RelatedType.
	Cells []any `json:"cells,omitempty" tstype:"unknown[]"`
	// More counts the Resources a row with status "more" stands for.
	More int `json:"more,omitempty"`
}

type RelatedType struct {
	Type    TypeKey  `json:"type"`
	Columns []Column `json:"columns"`
}

// RelationshipKind identifies a directed kind of Relationship.
type RelationshipKind string

const (
	RelationshipKindOwns RelationshipKind = "owns"
)

// RelatedDirection says whether a Relationship points into or out of a Resource.
type RelatedDirection string

const (
	RelatedDirectionIn  RelatedDirection = "in"
	RelatedDirectionOut RelatedDirection = "out"
)

// RelatedStatus reports whether a related Resource resolved.
type RelatedStatus string

const (
	RelatedStatusFound     RelatedStatus = "found"
	RelatedStatusSelf      RelatedStatus = "self"
	RelatedStatusMore      RelatedStatus = "more"
	RelatedStatusMissing   RelatedStatus = "missing"
	RelatedStatusUnserved  RelatedStatus = "unserved"
	RelatedStatusForbidden RelatedStatus = "forbidden"
	RelatedStatusSyncing   RelatedStatus = "syncing"
	RelatedStatusFailed    RelatedStatus = "failed"
)
