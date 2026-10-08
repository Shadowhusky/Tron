import { useEffect, useState } from "react";
import { IPC } from "../constants/ipc";
import { listPortForwards } from "../services/portForwards";
import type { PortForward } from "../types";

const NONE: PortForward[] = [];

/** Live list of a session's port forwards (empty when disabled). */
export function usePortForwards(sessionId: string | undefined, enabled: boolean): PortForward[] {
  const [state, setState] = useState<{ sessionId?: string; forwards: PortForward[] }>({ forwards: NONE });

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let alive = true;
    listPortForwards(sessionId)
      .then((list) => { if (alive && Array.isArray(list)) setState({ sessionId, forwards: list }); })
      .catch(() => {});
    const off = window.electron?.ipcRenderer?.on?.(
      IPC.SSH_FORWARDS_CHANGED,
      (data: { sessionId: string; forwards: PortForward[] }) => {
        if (data?.sessionId === sessionId) setState({ sessionId, forwards: data.forwards || NONE });
      },
    );
    return () => {
      alive = false;
      off?.();
    };
  }, [sessionId, enabled]);

  return enabled && state.sessionId === sessionId ? state.forwards : NONE;
}
