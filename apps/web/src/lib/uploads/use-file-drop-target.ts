import { useCallback, useRef, useState } from "react";

/**
 * Hook for handling file drop targets with drag-and-drop support
 */
export function useFileDropTarget(
  onDrop?: ((transfer: DataTransfer, directory: string) => void) | null
) {
  const dragCounterRef = useRef(0);
  const [activeTarget, setActiveTarget] = useState<string | null>(null);

  const onDragEnter = useCallback((directory: string) => (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current += 1;

    if (dragCounterRef.current === 1) {
      setActiveTarget(directory);
      if (event.currentTarget instanceof HTMLElement) {
        event.currentTarget.classList.add("drag-over");
      }
    }
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current -= 1;

    if (dragCounterRef.current === 0) {
      setActiveTarget(null);
      if (event.currentTarget instanceof HTMLElement) {
        event.currentTarget.classList.remove("drag-over");
      }
    }
  }, []);

  const onDropHandler = useCallback(
    (directory: string) => (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setActiveTarget(null);

      if (event.currentTarget instanceof HTMLElement) {
        event.currentTarget.classList.remove("drag-over");
      }

      if (onDrop && event.dataTransfer) {
        onDrop(event.dataTransfer, directory);
      }
    },
    [onDrop]
  );

  const props = useCallback(
    (directory: string) => {
      if (!onDrop) return {};

      return {
        onDragEnter: onDragEnter(directory),
        onDragOver,
        onDragLeave,
        onDrop: onDropHandler(directory),
      };
    },
    [onDrop, onDragEnter, onDragOver, onDragLeave, onDropHandler]
  );

  return {
    props,
    activeTarget,
  };
}
