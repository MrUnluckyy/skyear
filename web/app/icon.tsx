import { ImageResponse } from "next/og";

/** Favicon: the ear, as a single sodium dot inside an arriving ring. */
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#080d12",
          borderRadius: 7,
        }}
      >
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 24,
            border: "2px solid #f0a94c",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: 0.55,
          }}
        >
          <div style={{ width: 9, height: 9, borderRadius: 9, background: "#f0a94c", display: "flex" }} />
        </div>
      </div>
    ),
    size
  );
}
