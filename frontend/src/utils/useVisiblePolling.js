import { useEffect, useRef } from 'react';

// setInterval that pauses while the document is hidden and re-fires once on
// the visibility-resume transition so the UI catches up. Use this for every
// recurring fetch — background tabs were a major Supabase egress sink.
export function useVisiblePolling(callback, delay) {
  const cbRef = useRef(callback);
  useEffect(() => { cbRef.current = callback; }, [callback]);

  useEffect(() => {
    if (delay == null) return undefined;
    let id = null;
    const start = () => {
      if (id != null) return;
      id = setInterval(() => cbRef.current(), delay);
    };
    const stop = () => {
      if (id != null) { clearInterval(id); id = null; }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        cbRef.current();
        start();
      } else {
        stop();
      }
    };
    if (typeof document === 'undefined' || document.visibilityState === 'visible') start();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
    }
    return () => {
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
      }
    };
  }, [delay]);
}