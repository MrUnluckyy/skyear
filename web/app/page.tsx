"use client";

import dynamic from "next/dynamic";

// MapLibre needs the DOM at construction time, so the map must not render on
// the server. `ssr: false` requires a client boundary, hence "use client" here.
const SkyMap = dynamic(() => import("@/components/SkyMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh w-full items-center justify-center text-sm text-neutral-500">
      Loading map…
    </div>
  ),
});

export default function Home() {
  return <SkyMap />;
}
