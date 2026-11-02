# YouTube in Discover

Open **Discover > Sources**. Give the source a name, paste its HTTPS YouTube
channel URL (`/@handle`, `/channel/UC…`, `/user/name` or `/c/name`), choose a
group and select **Add source**. Athena resolves it to the channel's public
Atom feed. Select **Check now**, or wait for the normal discovery sync.

The same Sources form also automatically recognises RSS/Atom feeds and public
blog listings, for example `https://microsoft.ai/blog/`. Give it the name
**Microsoft AI**, choose **Microsoft**, and use **Add source**. Website entries
are labelled **Website** in the existing source list and use the same schedule,
pause/remove controls, scoring, project fit, article cards and URL deduplication
as feed entries. Adding/checking a source does not publish or approve content.

Microsoft AI receives a source-specific 2x priority relative to an equivalent
official Microsoft source, identified by the real `microsoft.ai` article or
listing URL rather than the editable name. This is applied live in shared
Discovery ranking, including podcast research and daily roundups, without a
rescore. Relevance, freshness, article type, project fit, user preferences and
source diversity still apply; posts are not pinned above stronger stories.
Other website sources do not inherit this priority. The effective authority
factor remains visible through the existing ranking breakdown.

Website discovery reads linked article headings from public HTML and checks
the article pages for publication metadata (article-specific structured data,
publication meta tags or publication times). Links can be outside the listing's
path, as Microsoft AI's `/blog/` links to `/news/`. Navigation links are excluded;
tracking parameters and canonical aliases are deduplicated. The first 30 unique
article links are checked, with at most five article-page requests at once.
Only posts within the existing 14-day window are imported. Modification dates
and retrieval times are not substituted for missing publication dates.

Source status and add-source results show warnings for skipped undated posts,
unreadable articles and bounded listing coverage. If no article links can be
identified, or all article requests fail, the source reports an error instead of
claiming a successful empty check. JavaScript-only pages and login-protected
sites are not supported; there is no browser automation or third-party scraping
service. Requests use the existing public-address/redirect safeguards with
bounded response sizes and timeouts. Imported text is a publisher summary, not
proof Athena has read the complete article.

Athena can list source kinds, URLs, warnings and current status with
`get_discover_sources`, inspect a candidate read-only with
`inspect_discover_feed`, and add/rename/regroup/pause sources with the existing
source tools and write approval boundaries. The form and Athena share the same
source validation/persistence; completed chat changes refresh the source list.
Deployment applies additive migration `138_discovery_websites.sql`; existing
subscriptions default to feed sources and retain their state. The migration
does not automatically subscribe or import anything.

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
