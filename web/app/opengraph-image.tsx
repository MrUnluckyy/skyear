import { ImageResponse } from "next/og";

/**
 * The link preview.
 *
 * Generated rather than a checked-in PNG so it cannot drift from the project's
 * own palette, and so there is no binary in the repo to forget about. Drawn
 * with the same idea as the map: wavefronts collapsing inward, because a
 * microphone receives sound rather than emitting it, which is the one image
 * that says what this is before anyone reads a word.
 */

export const alt = "SkyEar — security cameras listening for aircraft";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const NIGHT = "#080d12";
const SODIUM = "#f0a94c";
const BONE = "#e6edf2";
const SLATE = "#7d95a4";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: NIGHT,
          position: "relative",
          fontFamily: "sans-serif",
        }}
      >
        {/* Arriving wavefronts. Concentric rings centred on the ear. */}
        {[520, 400, 280, 170].map((d, i) => (
          <div
            key={d}
            style={{
              position: "absolute",
              right: 120 - d / 2 + 90,
              top: 315 - d / 2,
              width: d,
              height: d,
              borderRadius: d,
              border: `2px solid ${SODIUM}`,
              opacity: 0.1 + i * 0.13,
              display: "flex",
            }}
          />
        ))}
        <div
          style={{
            position: "absolute",
            right: 196,
            top: 303,
            width: 24,
            height: 24,
            borderRadius: 24,
            background: SODIUM,
            display: "flex",
          }}
        />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "0 72px",
            maxWidth: 760,
          }}
        >
          <div style={{ display: "flex", fontSize: 26, color: SODIUM, letterSpacing: 1 }}>
            SkyEar
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 62,
              color: BONE,
              lineHeight: 1.1,
              marginTop: 22,
              letterSpacing: -1.5,
            }}
          >
            Your camera already hears aircraft
          </div>
          <div
            style={{ display: "flex", fontSize: 27, color: SLATE, lineHeight: 1.4, marginTop: 26 }}
          >
            Every detection checked against live ADS-B — so the map shows what was missed as
            well as what was heard.
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            left: 72,
            bottom: 52,
            display: "flex",
            fontSize: 22,
            color: SLATE,
          }}
        >
          skyear.lt
        </div>
      </div>
    ),
    size
  );
}
