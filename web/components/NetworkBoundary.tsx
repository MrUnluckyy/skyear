/**
 * The privacy model as a mechanism, not a promise.
 *
 * Every product claims to respect privacy, so the sentence is worthless on its
 * own. What SkyEar can show instead is the shape of the wiring: the agent sits
 * inside the network holding the camera, and there is exactly one line leaving
 * it. The password, the video and the exact position are not filtered out at
 * the boundary - they are drawn stopping short of it, because nothing carries
 * them. That is the difference between a policy and an architecture, and it is
 * the thing worth drawing.
 *
 * Colour follows the meaning already set in globals.css: sodium is us, on the
 * ground, listening; frost is the far side. Here that gives one rule, and the
 * lists beside the drawing obey it too: sodium is yours and stays, frost is
 * SkyEar's and is sent. The outbound line is therefore frost, because it is
 * drawn in the colour of what receives it.
 *
 * Portrait on purpose. A wide diagram collapses to unreadable text on a phone,
 * and a vertical flow also reads as outward - the direction the claim is about.
 * The lists beside it carry the same facts in text, so this is aria-hidden
 * rather than burdened with a description nobody would hear out.
 */
export default function NetworkBoundary() {
  return (
    <svg
      viewBox="0 0 360 486"
      className="h-auto w-full max-w-[360px]"
      role="presentation"
      aria-hidden="true"
    >
      <defs>
        <marker
          id="nb-tip-slate"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 Z" fill="var(--slate-dim)" />
        </marker>
        <marker
          id="nb-tip-frost"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 Z" fill="var(--frost)" />
        </marker>
      </defs>

      {/* Your network. Three sides drawn; the fourth is the boundary below. */}
      <path
        d="M14,356 L14,26 L346,26 L346,356"
        fill="none"
        stroke="var(--sodium)"
        strokeOpacity="0.3"
      />
      <text x="26" y="46" fontSize="11" fill="var(--sodium)" fillOpacity="0.85">
        Your network
      </text>

      {/* Camera */}
      <rect x="105" y="62" width="150" height="50" fill="var(--night)" stroke="var(--edge)" />
      <text x="180" y="84" fontSize="15" fill="var(--bone)" textAnchor="middle">
        Camera
      </text>
      <text x="180" y="101" fontSize="11.5" fill="var(--slate-dim)" textAnchor="middle">
        the microphone it already has
      </text>

      <line
        x1="180"
        y1="112"
        x2="180"
        y2="146"
        stroke="var(--slate-dim)"
        markerEnd="url(#nb-tip-slate)"
      />
      <text x="190" y="133" fontSize="11.5" fill="var(--slate-dim)">
        audio
      </text>

      {/* Agent */}
      <rect x="85" y="148" width="190" height="58" fill="var(--night)" stroke="var(--edge)" />
      <text x="180" y="172" fontSize="15" fill="var(--bone)" textAnchor="middle">
        SkyEar agent
      </text>
      <text x="180" y="190" fontSize="11.5" fill="var(--slate-dim)" textAnchor="middle">
        listens, matches, decides
      </text>

      {/* What has no wire. The line stops at a cap rather than an arrowhead. */}
      <line x1="120" y1="206" x2="120" y2="238" stroke="var(--slate-dim)" strokeDasharray="3 3" />
      <line x1="96" y1="238" x2="144" y2="238" stroke="var(--slate-dim)" />
      <text x="120" y="257" fontSize="12" fill="var(--slate)" textAnchor="middle">
        password
      </text>
      <text x="120" y="274" fontSize="12" fill="var(--slate)" textAnchor="middle">
        video
      </text>
      <text x="120" y="291" fontSize="12" fill="var(--slate)" textAnchor="middle">
        exact position
      </text>
      <text x="120" y="313" fontSize="11" fill="var(--slate-dim)" textAnchor="middle">
        nothing carries these
      </text>

      {/* The one line out. The dot makes the direction unmistakable. */}
      <line
        x1="250"
        y1="206"
        x2="250"
        y2="404"
        stroke="var(--frost)"
        strokeOpacity="0.75"
        markerEnd="url(#nb-tip-frost)"
      />
      <circle className="nb-outbound" cx="250" cy="212" r="3.5" fill="var(--frost)" />
      <text x="264" y="296" fontSize="11.5" fill="var(--frost)" fillOpacity="0.9">
        one event
      </text>

      {/* The boundary itself */}
      <line x1="14" y1="356" x2="346" y2="356" stroke="var(--sodium)" strokeOpacity="0.3" strokeDasharray="5 4" />
      {/* Anchored left: right-anchored, it ran straight through the outbound
          arrow at x=250. */}
      <text x="14" y="374" fontSize="11" fill="var(--slate-dim)">
        your network ends here
      </text>

      {/* SkyEar */}
      <rect x="85" y="406" width="190" height="56" fill="var(--night)" stroke="var(--frost)" strokeOpacity="0.35" />
      <text x="180" y="429" fontSize="15" fill="var(--frost)" textAnchor="middle">
        SkyEar
      </text>
      <text x="180" y="447" fontSize="11.5" fill="var(--slate-dim)" textAnchor="middle">
        the map, and the database
      </text>
    </svg>
  );
}
