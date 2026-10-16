import { ImageResponse } from "next/og";

export const size = {
  width: 64,
  height: 64,
};

export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#020617",
          borderRadius: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 11,
            top: 18,
            width: 42,
            height: 32,
            background: "#0f172a",
            border: "2px solid #334155",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 25,
            top: 18,
            width: 2,
            height: 32,
            background: "#10b981",
            opacity: 0.85,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 37,
            top: 18,
            width: 2,
            height: 32,
            background: "#10b981",
            opacity: 0.85,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 11,
            top: 29,
            width: 42,
            height: 2,
            background: "#10b981",
            opacity: 0.85,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 22,
            top: 9,
            width: 20,
            height: 20,
            background: "#10b981",
            borderRadius: "50% 50% 50% 0",
            transform: "rotate(-45deg)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 29,
            top: 16,
            width: 6,
            height: 6,
            background: "#020617",
            borderRadius: 999,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 21,
            bottom: 9,
            width: 22,
            height: 4,
            background: "#10b981",
            borderRadius: 999,
          }}
        />
      </div>
    ),
    size
  );
}
