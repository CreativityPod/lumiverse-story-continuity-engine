# Image generation with Story Continuity

The `WHEN` line uses readable dates without Gregorian years and AM/PM times, for example `October 17 (Fall); 02:54 PM (Afternoon)`. Seasonal descriptions come from established scene facts; clock-period labels alone do not establish sunlight or weather.

Use this macro in Lumiverse ImageGen's **Chat-aware Custom** Main preset:

```text
{{getchatvar::story_continuity.visual_text_v1}}
```

It expands to a labeled, observable-only snapshot of the committed current scene.
It selects the main character, user character and colocated cast, plus current
places. Character and place aliases retain names. Stable labels include `WHEN`,
`WEATHER`, `LOCATION`, `CONTEXT`, `PROXIMITY & CONTACT`, `CHARACTER`,
`STABLE APPEARANCE`, `FACE`, `EYES`, `SKIN`, `BODY TYPE & PROPORTIONS`,
`DISTINGUISHING FEATURES`, `CURRENT VISIBLE`, `HAIR & GROOMING`,
`DRESS & LAYERS`, `PHYSICAL STATE`, `POSITION`, `ACTIVITY` and `ITEMS`.
Unknown fields are omitted. A field not present is not permission to invent it.

The image snapshot excludes stable private profiles, internal states, secrets,
private place facts, relationships, objectives and source-message identifiers.
All original JSON macros remain available in their existing formats.

## Parser instructions

```text
Create an image-generation prompt for the current observable story scene.

<CURRENT_SCENE>
{{getchatvar::story_continuity.visual_text_v1}}
</CURRENT_SCENE>

Use CURRENT_SCENE as the primary source for the fictional date/time, weather,
location, stable appearance, current hair/grooming, clothing/layers, visible
physical condition, positions, contact and important items. Character and place
aliases are bookkeeping; use names or visual descriptions in the image prompt.
An included character is a continuity reference, not a requirement to depict
everyone. Use established positions and recent explicit events to choose the
subjects actually visible in the intended composition.

Recent chat may supply a later explicitly established outfit change, action,
pose or expression after this checkpoint. Apply that later event without
inventing intermediate events or silently resetting recorded appearance.

Omitted and Unknown details are unresolved or outside this selected snapshot.
Do not infer missing appearance, removed clothing, contact, feelings or hidden
physical conditions. An intention or feeling does not establish an expression,
pose or visible bodily reaction. Fictional time is not the real current time.

Return only the final image prompt describing visible subjects, appearance,
clothing, pose, spatial relationships, environment, framing and lighting.
```

## Freshness and scope

ImageGen's parser reads chat variables separately from the roleplay interceptor.
The mirror changes after a valid continuity checkpoint commits; it does not run
the tracker or add a generation call. Automatic ImageGen may read the preceding
checkpoint while tracking the latest reply is still in progress. For the most
reliable manual result, wait until the Story Continuity drawer shows the latest
turn as tracked. The recent-chat rule above permits later explicit visual events
to take precedence. Empty or incomplete setups do not expose preview state.

Both story injection and this image snapshot have a 24,000-character text budget.
Whole field values or records may be omitted, while complete canonical JSON
remains saved. The image budget is spent entirely on observable fields. Existing
JSON integrations can continue using `story_continuity.public_v1`.
