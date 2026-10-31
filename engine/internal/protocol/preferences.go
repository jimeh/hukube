package protocol

// App preferences are shared by all windows connected to this Engine.
const (
	PreferenceDefaultTheme       = "dark"
	PreferenceDefaultWrap        = true
	PreferenceDefaultTimestamps  = false
	AppPreferencesKey            = "app/preferences"
	PreferenceMaxLines           = 100000
	PreferenceMaxCharacters      = 64000000
	PreferenceMaxDecorations     = 400000
	PreferenceDefaultLines       = 50000
	PreferenceDefaultCharacters  = 32000000
	PreferenceDefaultDecorations = 200000
)

type AppPreferences struct {
	Version    int                    `json:"version"`
	Appearance *AppearancePreferences `json:"appearance,omitempty"`
	LogStreams *LogStreamPreferences  `json:"logStreams,omitempty"`
}
type AppearancePreferences struct {
	Theme *string `json:"theme,omitempty"`
}
type LogStreamPreferences struct {
	MaxLines       *int  `json:"maxLines,omitempty"`
	MaxCharacters  *int  `json:"maxCharacters,omitempty"`
	MaxDecorations *int  `json:"maxDecorations,omitempty"`
	Wrap           *bool `json:"wrap,omitempty"`
	Timestamps     *bool `json:"timestamps,omitempty"`
}
