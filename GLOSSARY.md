# Spotify Plus

Personal music organization through Liked Songs review into maintained playlists, tags, selected Spotify sources and disposable generated playlists.

## Language

**Source**:
Liked Songs or a Spotify playlist whose songs can contribute to the shared song pool.

**Source membership**:
A song's presence in a particular source, independent of its presence in another source.

**Song pool**:
The unique songs contributed by enabled sources and available for browsing, tagging and playlist queries.

**Song**:
One taggable musical entry, potentially represented by several matching Spotify tracks.
_Avoid_: Using song and Spotify track interchangeably when discussing duplicates.

**Spotify track**:
A particular Spotify catalog identity that can represent a song in a source or generated playlist.

**Representative**:
The eligible Spotify track used to display, open or play a song and include it in generated playlists.

**Generated playlist**:
An app-managed Spotify playlist containing a snapshot of a tag query's matching songs.

**Annotation**:
The user's persistent tagging information, preserved independently of Spotify membership and cached metadata.

### Liked Songs review

**Destination playlist**:
An existing Spotify playlist the user has chosen to offer as a destination during Liked Songs review.
_Avoid_: Generated playlist (which specifically describes a tag-query snapshot).

**Liked Songs backlog**:
The user's currently liked Spotify tracks awaiting review for playlist placement, ordered from oldest-liked to newest-liked. Each Spotify track is reviewed separately, even when several tracks represent the same song.
