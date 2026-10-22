# YouTube in Discover

Open **Discover > Sources**. Give the source a name, paste its HTTPS YouTube
channel URL (`/@handle`, `/channel/UC…`, `/user/name` or `/c/name`), choose a
group and select **Add source**. Athena resolves it to the channel's public
Atom feed. Select **Check now**, or wait for the normal discovery sync.

Channel feeds contain a limited recent window, not the complete channel archive.
The existing 14-day discovery window, scoring, project relevance and shelving
rules still apply. Pause or remove the source using the existing controls.

Publishing relevance is Microsoft-first, including GitHub and Microsoft Research,
for articles and videos alike. Official Microsoft/GitHub sources receive a 1.8
ranking weight versus 1.1 for other official vendors; significant competitor
stories can still rank higher on their merits. The known Microsoft Azure
YouTube feed is identified by its channel ID, not its display name.
Description-only evidence does not justify inventing video contents or assuming
the video itself is shallow.

Articles are no longer automatically shelved merely because time has passed
since import. Explicit low-value triage remains, with existing protection for
restored items and directly relevant projects. Saved items are unaffected.

For an individual video, use **Add video** in the same Sources panel.
Watch, youtu.be, Shorts and live video links are normalised to one canonical
watch URL, preventing duplicates across link formats. Manual imports can be
older than the channel discovery window. Existing saved/parked workflow state
is preserved when importing the same video again.

Imports now attempt one public caption track advertised by the watch page,
preferring authored English, then automatic English, then another available
language. Captions retain source timings and are labelled with language,
automatic-generation status and any truncation. A blocked, empty or missing
track leaves the video explicitly **description only**; retrieval status is
stored rather than implying the video has been watched.

When captions cannot be retrieved, one bounded secondary search through the
existing configured Tavily integration looks up the video's title and channel.
Up to three non-YouTube background sources are stored with titles, URLs and
search excerpts. Discover's video details shows **Related background reading**
links. These explain the subject, not what the video said; they are never
labelled transcripts or independent verification of spoken claims. Missing
configuration, failed search and no results are recorded distinctly.

Manual imports perform this evidence collection. Production feed background
work also enriches up to five previously imported videos per sync, sequentially,
before scoring/deep dives; development does not run that automatic work.
Unreadable watch pages get at most two background attempts. Successful caption
checks, including unavailable captions, are recorded once per enrichment version.
Deep dives use this stored evidence, not YouTube navigation mistaken for full
video text, and can enrich an older video on demand. Re-enrichment preserves
workflow/parking state and other metadata and invalidates its semantic-index copy.

No paid transcript service, audio/video download, authentication bypass or
automatic transcription is used. Secondary search uses existing provider
allowances. Private, restricted or unreadable manual imports still return an
explicit error. Public captions can be inaccurate, and description-only evidence
must not support invented quotations or timestamped claims.
