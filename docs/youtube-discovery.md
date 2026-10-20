# YouTube in Discover

Open **Discover > Sources**. Give the source a name, paste its HTTPS YouTube
channel URL (`/@handle`, `/channel/UC…`, `/user/name` or `/c/name`), choose a
group and select **Add source**. Athena resolves it to the channel's public
Atom feed. Select **Check now**, or wait for the normal discovery sync.

Channel feeds contain a limited recent window, not the complete channel archive.
The existing 14-day discovery window, scoring, project relevance and shelving
rules still apply. Pause or remove the source using the existing controls.

For an individual video, use **Add video** in the same Sources panel.
Watch, youtu.be, Shorts and live video links are normalised to one canonical
watch URL, preventing duplicates across link formats. Manual imports can be
older than the channel discovery window. Existing saved/parked workflow state
is preserved when importing the same video again.

This release imports public metadata and descriptions, not transcripts or audio.
Video content is explicitly labelled **description only; no transcript
retrieved** in the indexed source text, including the material Athena receives.
It must not be treated as evidence for spoken quotations or timestamped claims.
No paid transcript service, automatic transcription or video download is used.
Private, unavailable, restricted or unreadable pages return an explicit error.
