import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { io } from "socket.io-client";
import { useAuth } from "./AuthContext";

type FriendsConnection = {
  connected: boolean;
  revision: number;
  retry: () => void;
};
const Context = createContext<FriendsConnection>({
  connected: false,
  revision: 0,
  retry: () => {},
});
export const useFriendsConnection = () => useContext(Context);

export function FriendsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const reconnectRef = useRef<() => void>(() => {});
  const invalidate = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!user) {
      setConnected(false);
      return;
    }
    const socket = io("/friends", {
      path: "/socket.io",
      auth: { csrf: "1" },
      withCredentials: true,
      forceNew: true,
      autoConnect: false,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(invalidate, 200);
    };
    const ready = () => {
      setConnected(true);
      schedule();
    };
    const disconnected = () => {
      setConnected(false);
      schedule();
    };
    socket.on("friends:ready", ready);
    socket.on("friends:changed", schedule);
    socket.on("disconnect", disconnected);
    socket.on("connect_error", disconnected);
    reconnectRef.current = () => {
      if (!socket.connected && !socket.active) socket.connect();
    };
    // Defer connecting so StrictMode cleanup can cancel
    // the development-only initial effect cycle.
    const connectTimer = window.setTimeout(() => {
      socket.connect();
    }, 0);

    const onFocus = () => {
      schedule();
      if (!socket.connected && !socket.active) socket.connect();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(connectTimer);
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      socket.removeAllListeners();
      socket.disconnect();
      setConnected(false);
      reconnectRef.current = () => {};
    };
  }, [user?.id, invalidate]);
  return (
    <Context.Provider
      value={{ connected, revision, retry: () => reconnectRef.current() }}
    >
      {children}
    </Context.Provider>
  );
}
