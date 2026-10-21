export function Icon({
  name,
}: {
  name:
    | "queue"
    | "library"
    | "builder"
    | "playlists"
    | "vocabulary"
    | "artist"
    | "album"
    | "playlist"
    | "decade";
}) {
  const paths = {
    artist: "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0M5 21v-2a7 7 0 0 1 14 0v2",
    album: "M3 3h20v18H3zM18 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0M13 12h.01",
    playlist: "M5 5h16M5 10h16M5 15h9M19 15v7m-3-3 3 3 3-3",
    decade: "M4 6h18v16H4zM8 3v6M18 3v6M4 12h18",
    queue: "M4 5h11M4 12h11M4 19h7M19 4v16m-3-3 3 3 3-3",
    library: "M4 4h4v16H4zM11 4h4v16h-4zM18 5l3-1 3 15-3 1z",
    builder: "M4 5h10M4 11h10M4 17h6M19 10v10m-5-5h10",
    playlists: "M4 5h16M4 11h16M4 17h9m5-2 4 3-4 3z",
    vocabulary: "M3 4h9l9 9-8 8-10-10zM7 8h.01",
  };
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 26 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
