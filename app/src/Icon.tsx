export function Icon({
  name,
}: {
  name: "queue" | "library" | "builder" | "playlists" | "vocabulary";
}) {
  const paths = {
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
