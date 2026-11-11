import { useLayoutEffect, useRef, useState } from "react";

export function useThreadFollow(conversationKey: string, update: unknown, active: boolean) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);

  const toLatest = () => {
    following.current = true;
    setAway(false);
    setUnseen(false);
    const viewport = viewportRef.current;
    if (viewport?.clientHeight) viewport.scrollTop = viewport.scrollHeight;
  };

  const onScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport?.clientHeight) return;
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 40;
    following.current = atBottom;
    setAway(!atBottom);
    if (atBottom) setUnseen(false);
  };

  useLayoutEffect(toLatest, [conversationKey]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!active || !viewport?.clientHeight) return;
    if (following.current) viewport.scrollTop = viewport.scrollHeight;
    else setUnseen(true);
  }, [update, active]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      if (viewport.clientHeight && following.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return { viewportRef, contentRef, onScroll, toLatest, away, unseen };
}
