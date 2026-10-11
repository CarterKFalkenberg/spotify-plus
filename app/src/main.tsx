import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useSearchParams,
} from "react-router";
import { disconnect, readSession, type Session } from "./session";
import "./style.css";
const authErrors: Readonly<Record<string, { title: string; detail: string }>> =
  {
    consent_denied: {
      title: "Spotify connection cancelled",
      detail:
        "You declined Spotify permission. Choose Connect Spotify when you are ready to approve the listed permissions.",
    },
    wrong_account: {
      title: "Use your registered Spotify account",
      detail:
        "This app belongs to one account. Sign out of the other account in Spotify, then connect with the registered account.",
    },
    forbidden: {
      title: "Spotify could not grant access",
      detail:
        "Check the app’s Users Management allowlist, the app owner’s Premium subscription, and granted permissions in the Spotify developer dashboard. Spotify’s response does not identify which check failed.",
    },
    reconnect: {
      title: "Reconnect Spotify",
      detail:
        "Your Spotify authorization needs renewing. Reconnect with the same account to continue.",
    },
    missing_scopes: {
      title: "Some permissions are missing",
      detail:
        "Connect again and approve all listed permissions. Library write permission is used only to remove app-managed playlists; your Liked Songs are never changed.",
    },
    temporarily_unavailable: {
      title: "Connection temporarily unavailable",
      detail:
        "Spotify or the app could not finish this request. Wait a moment, then try again.",
    },
    invalid_state: {
      title: "This connection attempt expired",
      detail:
        "Start a fresh connection from this page. Use the same browser to finish Spotify authorization.",
    },
    invalid_callback: {
      title: "Spotify connection was incomplete",
      detail:
        "Start a fresh connection and finish the Spotify authorization screen.",
    },
    authorization_cancelled: {
      title: "This connection attempt was cancelled",
      detail:
        "An account change cancelled the previous attempt. Start a fresh connection when you are ready.",
    },
    authorization_failed: {
      title: "Spotify connection did not finish",
      detail:
        "Try connecting again. If it continues, check the registered callback URL and Spotify app settings.",
    },
  };
function Home() {
  const [params] = useSearchParams();
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const authCode = params.get("auth_error");
  const authError = authCode
    ? (authErrors[authCode] ?? authErrors.authorization_failed)
    : undefined;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      try {
        const next = await readSession(controller.signal);
        if (controller.signal.aborted) return;
        setSession(next);
        setFailed(false);
        if (next.connection === "disconnecting")
          timer = setTimeout(() => {
            void update();
          }, 3000);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    };
    void update();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [attempt]);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  async function removeData() {
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await disconnect();
      setSession({ authenticated: false, connection: "disconnecting" });
      setConfirming(false);
      setAttempt((value) => value + 1);
    } catch {
      setDeleteFailed(true);
    } finally {
      setDeleting(false);
    }
  }
  const pending = session?.connection === "disconnecting";
  const connected = session?.authenticated;
  return (
    <>
      <div className="eyebrow">YOUR LIBRARY, IN YOUR WORDS</div>
      <h1>
        Good music.
        <br />
        <span>Your kind of order.</span>
      </h1>
      <p className="intro">
        A quiet place for your Liked Songs, personal tags, and playlists for the
        moment.
      </p>
      <section className="connection-card" aria-labelledby="connection-title">
        <div className="card-kicker">
          <span className="status-dot" />
          PRIVATE · ONE ACCOUNT
        </div>
        {authError && (
          <div role="alert" className="notice">
            <h2>{authError.title}</h2>
            <p>{authError.detail}</p>
          </div>
        )}
        {failed ? (
          <div role="alert">
            <h2 id="connection-title">We couldn’t check your connection</h2>
            <p>
              The service may be temporarily unavailable. Try again in a moment.
            </p>
            <button
              onClick={() => {
                setFailed(false);
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </button>
          </div>
        ) : !session ? (
          <div role="status">
            <h2 id="connection-title">Checking your connection…</h2>
            <p>Just a moment.</p>
          </div>
        ) : pending ? (
          <div role="status">
            <h2 id="connection-title">Finishing data deletion</h2>
            <p>
              Your Spotify connection is disabled. We’re verifying that all
              app-controlled annotation backups are gone. You can close this
              page; cleanup continues in the background.
            </p>
            <p>
              Existing Spotify playlists stay in your library. Automatic
              playlist cleanup has stopped.
            </p>
            <a
              href="https://www.spotify.com/account/apps/"
              target="_blank"
              rel="noreferrer"
            >
              Revoke Spotify access ↗
            </a>
          </div>
        ) : connected ? (
          <>
            <h2 id="connection-title">
              {session.connection === "reconnect"
                ? "Reconnect to continue"
                : "Spotify is connected"}
            </h2>
            <p>
              {session.connection === "reconnect"
                ? "Your authorization has expired or needs renewing. Reconnect with the same Spotify account."
                : "Your account is ready for the next step."}
            </p>
            {session.reconnectWarning && session.connection !== "reconnect" && (
              <p className="notice" role="status">
                Reconnect soon: Spotify authorization reaches its renewal
                deadline on{" "}
                {new Date(session.authorizationDeadline!).toLocaleDateString(
                  undefined,
                  { dateStyle: "long", timeZone: "America/New_York" },
                )}
                .
              </p>
            )}
            {session.connection === "reconnect" || session.reconnectWarning ? (
              <a className="button" href="/auth/spotify/start">
                Reconnect Spotify
              </a>
            ) : null}
            <button
              className="text-button"
              ref={settingsRef}
              onClick={() => setConfirming(true)}
            >
              Disconnect & delete app data
            </button>
          </>
        ) : (
          <>
            <h2 id="connection-title">Start with your Spotify</h2>
            <p>
              Connect the account registered for this private app. Spotify is
              your only login.
            </p>
            <a className="button" href="/auth/spotify/start">
              Connect Spotify <span aria-hidden="true">↗</span>
            </a>
            <p className="permission-note">
              Your Liked Songs are never changed. Library write access is used
              only to remove playlists this app creates.
            </p>
          </>
        )}
      </section>
      <aside className="stage-note">
        <span>SETUP PREVIEW</span>
        <p>
          Connection and privacy controls are available here. Library sync,
          tagging, and playlist creation are still being built.
        </p>
      </aside>
      <div className="principles">
        <div>
          <span>01</span>
          <h3>Tag in your own words</h3>
          <p>Make room for moods, places, and everything between.</p>
        </div>
        <div>
          <span>02</span>
          <h3>Make a playlist for now</h3>
          <p>Choose your tags. Preview the songs. Listen in Spotify.</p>
        </div>
        <div>
          <span>03</span>
          <h3>Keep the clutter out</h3>
          <p>Set a retention window, or pin a playlist to keep it.</p>
        </div>
      </div>
      {confirming && (
        <div className="dialog-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            className="dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deleting) {
                setConfirming(false);
                settingsRef.current?.focus();
              }
              if (event.key === "Tab") {
                const buttons = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ];
                const first = buttons[0],
                  last = buttons.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <h2 id="delete-title">Delete everything in this app?</h2>
            <p>
              This deletes your tags, cached library, connection credentials,
              and app-controlled annotation backups.
            </p>
            <p>
              <strong>Your existing Spotify playlists stay.</strong> Automatic
              playlist cleanup stops. Full grant revocation is a separate step
              on Spotify’s Apps page.
            </p>
            <p className="muted">
              A keyed owner fingerprint remains to keep this private app bound
              to your account. Provider-internal retention is outside the app’s
              controls.
            </p>
            {deleteFailed && (
              <p role="alert">
                Deletion could not be confirmed. Check your connection and try
                again; this page does not claim your data was deleted.
              </p>
            )}
            <div className="dialog-actions">
              <button
                ref={confirmRef}
                disabled={deleting}
                onClick={() => {
                  setConfirming(false);
                  settingsRef.current?.focus();
                }}
              >
                Keep my data
              </button>
              <button
                className="danger"
                disabled={deleting}
                onClick={() => {
                  void removeData();
                }}
              >
                {deleting ? "Disconnecting…" : "Delete all app data"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
function Policy({ type }: { type: "privacy" | "terms" }) {
  return (
    <article className="policy">
      <Link to="/">← Back to your app</Link>
      <h1>
        {type === "privacy" ? "Privacy, plainly." : "A personal workspace."}
      </h1>
      {type === "privacy" ? (
        <>
          <h2>One account. Your data.</h2>
          <p>
            Spotify Plus is a private app for one registered Spotify account.
            Spotify provides the login; no separate profile or email is
            collected.
          </p>
          <h2>What is stored</h2>
          <p>
            Authorization credentials are encrypted on the server. The app is
            being built to cache the track metadata needed for tagging, store
            your tags and playlist queries, and keep three encrypted daily
            annotation backups. Spotify artwork remains hosted by Spotify.
            Spotify content is not sent to AI services.
          </p>
          <p>
            Removed-track metadata is scheduled for deletion after 90 days. Tags
            and a minimal keyed identifier are kept so re-liking a song can
            restore your annotations.
          </p>
          <h2>Disconnect and delete</h2>
          <p>
            Disconnect disables access and jobs, deletes app data and
            credentials, then verifies removal of app-controlled backups. The
            page reports completion only after this purge. Existing Spotify
            playlists remain and automatic cleanup stops. A keyed account
            fingerprint remains solely to enforce the single-owner binding.
          </p>
          <p>
            Visit{" "}
            <a
              href="https://www.spotify.com/account/apps/"
              target="_blank"
              rel="noreferrer"
            >
              Spotify’s Apps page
            </a>{" "}
            to revoke the authorization grant. Provider-internal retention is
            outside the app’s control; app deletion does not promise immediate
            physical erasure from every provider system.
          </p>
          <h2>Hosting</h2>
          <p>
            The app runs on Supabase Free and Cloudflare Workers Free. Their
            service operation and retention policies also apply. No analytics,
            advertising, or tracking cookies are used; the secure session cookie
            keeps you signed in.
          </p>
        </>
      ) : (
        <>
          <h2>For your personal library</h2>
          <p>
            This private app is for one owner to organize their Liked Songs. It
            is not affiliated with or endorsed by Spotify. Listening happens in
            Spotify.
          </p>
          <h2>Your Liked Songs stay yours</h2>
          <p>
            The app never likes or unlikes tracks. Library write permission is
            restricted to removing app-managed playlists from Your Library.
            Removal does not necessarily destroy the Spotify playlist object or
            its URL.
          </p>
          <h2>Playlist behavior</h2>
          <p>
            The planned playlist workflow creates private snapshots. Regenerate
            replaces playlist contents while preserving your Spotify name and
            other description text. Retention removes an app-managed playlist
            from Your Library after the displayed expiry date unless you pin or
            extend it.
          </p>
          <h2>Availability and limits</h2>
          <p>
            Free hosting can pause or reach quotas. Unattended work resumes
            after service recovery; exact cleanup timing and uninterrupted
            availability are not guaranteed. No paid upgrade is made
            automatically.
          </p>
          <h2>Current availability</h2>
          <p>
            This is an internal connection and privacy preview. The full tagging
            and playlist workflow is not released yet.
          </p>
        </>
      )}
      <p className="muted">Updated October 11, 2026</p>
    </article>
  );
}
function App() {
  return (
    <div className="shell">
      <header>
        <Link className="wordmark" to="/" aria-label="Spotify Plus home">
          <span className="mark" aria-hidden="true">
            ≋
          </span>{" "}
          Spotify Plus
        </Link>
        <span className="private-label">A personal music workspace</span>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/privacy" element={<Policy type="privacy" />} />
          <Route path="/terms" element={<Policy type="terms" />} />
          <Route
            path="*"
            element={
              <article className="policy">
                <h1>Page not found</h1>
                <Link to="/">Back to your app</Link>
              </article>
            }
          />
        </Routes>
      </main>
      <footer>
        <span>Made for a library of one.</span>
        <nav aria-label="Legal">
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </nav>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
