import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/** Fade the cut edge only while another column is still off screen. */
export function TableScroll({ children, className }: {
  children: React.ReactNode;
  className?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = frame.current;
    setMore(Boolean(el && el.scrollWidth - el.clientWidth - el.scrollLeft > 1));
  };

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div className={cn("min-w-0 max-w-full overflow-hidden", className)}>
      <div
        ref={frame}
        className="overflow-x-auto"
        onScroll={measure}
        style={more ? { maskImage: "linear-gradient(to right, black calc(100% - 24px), transparent)" } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
