import Link from "next/link";

/**
 * One nav across every page that is not the map.
 *
 * Each page used to carry its own two or three links, chosen ad hoc, and the
 * result was that privacy was reachable from exactly two places on the whole
 * site - neither of them the pages where somebody decides whether to point a
 * microphone at their own street. A shared row fixes that by construction:
 * adding a destination here adds it everywhere.
 *
 * The current page stays in the list rather than disappearing from it, so the
 * set of places you can go does not change shape as you move around.
 */
const LINKS = [
  { href: "/", label: "Map" },
  { href: "/join", label: "Become a sensor" },
  { href: "/devices", label: "Your sensors" },
  { href: "/reading", label: "Reading the map" },
  { href: "/privacy", label: "Privacy" },
] as const;

export default function SiteNav({ current }: { current?: string }) {
  return (
    <nav aria-label="Site" className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px]">
      {LINKS.map(({ href, label }) => {
        const here = href === current;
        return (
          <Link
            key={href}
            href={href}
            aria-current={here ? "page" : undefined}
            className={here ? "text-bone" : "text-slate hover:text-sodium"}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
