import React from "react";

interface MetaEmblemProps {
  size?: number;
  animated?: boolean;
  className?: string;
}

export function MetaEmblem({
  size = 56,
  animated = true,
  className = "",
}: MetaEmblemProps) {
  const petals = [
    { angle: 0, fill: "url(#meta-p-0)" },
    { angle: 45, fill: "url(#meta-p-1)" },
    { angle: 90, fill: "url(#meta-p-2)" },
    { angle: 135, fill: "url(#meta-p-3)" },
    { angle: 180, fill: "url(#meta-p-4)" },
    { angle: 225, fill: "url(#meta-p-5)" },
    { angle: 270, fill: "url(#meta-p-6)" },
    { angle: 315, fill: "url(#meta-p-7)" },
  ];

  return (
    <div
      className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {/* Ambient gradient glow behind the emblem */}
      <div
        className="absolute inset-0 rounded-full blur-xl pointer-events-none opacity-70"
        style={{
          background:
            "radial-gradient(circle, rgba(22, 139, 255, 0.45) 0%, rgba(168, 85, 247, 0.3) 45%, transparent 75%)",
          transform: "scale(1.35)",
        }}
      />

      <svg
        viewBox="0 0 96 96"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Meta AI Emblem"
        className={animated ? "meta-emblem-spin" : ""}
        style={{ transformOrigin: "center" }}
      >
        <defs>
          <linearGradient id="meta-p-0" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#38BDF8" />
            <stop offset="100%" stopColor="#168BFF" />
          </linearGradient>
          <linearGradient id="meta-p-1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#168BFF" />
            <stop offset="100%" stopColor="#3B82F6" />
          </linearGradient>
          <linearGradient id="meta-p-2" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#3B82F6" />
            <stop offset="100%" stopColor="#6366F1" />
          </linearGradient>
          <linearGradient id="meta-p-3" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#6366F1" />
            <stop offset="100%" stopColor="#8B5CF6" />
          </linearGradient>
          <linearGradient id="meta-p-4" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#8B5CF6" />
            <stop offset="100%" stopColor="#A855F7" />
          </linearGradient>
          <linearGradient id="meta-p-5" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#A855F7" />
            <stop offset="100%" stopColor="#D946EF" />
          </linearGradient>
          <linearGradient id="meta-p-6" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#D946EF" />
            <stop offset="100%" stopColor="#EC4899" />
          </linearGradient>
          <linearGradient id="meta-p-7" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#EC4899" />
            <stop offset="100%" stopColor="#38BDF8" />
          </linearGradient>
        </defs>

        {petals.map((p, idx) => (
          <rect
            key={idx}
            x="43.5"
            y="11"
            width="9"
            height="22"
            rx="4.5"
            transform={`rotate(${p.angle + 28} 48 48)`}
            fill={p.fill}
          />
        ))}
      </svg>
    </div>
  );
}

export function MetaWordmark({ className = "" }: { className?: string }) {
  return (
    <div className={`inline-flex items-center gap-2 select-none ${className}`}>
      {/* Meta Infinity loop symbol */}
      <svg
        viewBox="0 0 32 32"
        width="22"
        height="22"
        fill="currentColor"
        className="text-white"
        aria-hidden="true"
      >
        <path d="M22.4 9C20.1 9 18.2 10.3 16.9 12.2C15.6 10.3 13.7 9 11.4 9C7.4 9 4 12.2 4 16.2C4 20.2 7.4 23.4 11.4 23.4C13.8 23.4 15.8 22 17.1 20C18.4 22 20.4 23.4 22.8 23.4C26.8 23.4 30.2 20.2 30.2 16.2C30.2 12.2 26.6 9 22.4 9ZM11.4 21C8.7 21 6.6 18.9 6.6 16.2C6.6 13.5 8.7 11.4 11.4 11.4C13.4 11.4 15.1 12.7 16 14.5C15.8 15.1 15.5 15.7 15.1 16.3C14.3 17.5 13.3 18.9 12.3 20.1C12 20.6 11.7 21 11.4 21ZM22.6 21C20.6 21 18.9 19.7 18 17.9C18.2 17.3 18.5 16.7 18.9 16.1C19.7 14.9 20.7 13.5 21.7 12.3C22 11.8 22.3 11.4 22.6 11.4C25.3 11.4 27.4 13.5 27.4 16.2C27.4 18.9 25.3 21 22.6 21Z" />
      </svg>
      <span className="font-semibold text-white tracking-tight text-base">Meta</span>
      <span className="text-xs px-2 py-0.5 rounded-md bg-[#24242a] text-[#38bdf8] border border-[#33333e] font-mono">
        AI
      </span>
    </div>
  );
}
